/**
 * Plannotator Plugin for OpenCode
 *
 * Provides a Claude Code-style planning experience with interactive plan review.
 * When the agent calls submit_plan, the Plannotator UI opens for the user to
 * annotate, approve, or request changes to the plan.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (devcontainer, SSH)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: 19432)
 *   PLANNOTATOR_PLAN_TIMEOUT_SECONDS - Max wait for submit_plan approval (default: 345600, set 0 to disable)
 *
 * @packageDocumentation
 */

import { join } from "path";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { isRemoteSession, handleServerReady } from "@plannotator/server";
import { handleReviewServerReady } from "@plannotator/server/review";
import { handleAnnotateServerReady } from "@plannotator/server/annotate";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import {
  type ReviewServerOptions,
  type ReviewServerResult,
} from "@plannotator/server/review";
import {
  type AnnotateServerOptions,
  type AnnotateServerResult,
} from "@plannotator/server/annotate";
import {
  PERSISTENT_SERVER_DEFAULT_PORT,
  type PlanDecision,
  type ReviewDecision,
  type AnnotateDecision,
} from "@plannotator/server/persistent";
import {
  REVIEW_TOOL_DIFF_TYPES,
  runPlannotatorAnnotateTool,
  runPlannotatorReviewTool,
  defaultAnnotateToolDependencies,
  defaultReviewToolDependencies,
} from "./tool-helpers";

const DEFAULT_PLAN_TIMEOUT_SECONDS = 345_600; // 96 hours

// ---------------------------------------------------------------------------
// Persistent server management
// ---------------------------------------------------------------------------

function getPersistentServerPort(): number {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return PERSISTENT_SERVER_DEFAULT_PORT;
}

const SERVER_PORT = getPersistentServerPort();
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

async function checkServerHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${SERVER_URL}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForServer(maxWaitMs = 5000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await checkServerHealth()) return true;
    await Bun.sleep(300);
  }
  return false;
}

async function ensureServerRunning(): Promise<void> {
  if (await checkServerHealth()) return;

  // Locate the server CLI bundle next to this file
  const serverCli = join(import.meta.dir, "server-cli.js");

  Bun.spawn(["bun", serverCli, "start"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });

  const ready = await waitForServer(6000);
  if (!ready) {
    throw new Error(
      `Plannotator server failed to start on port ${SERVER_PORT}. ` +
        `Try running: bun ${serverCli} start`
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP client wrappers for review and annotate servers
// (return the same ServerResult shape that tool-helpers expects)
// ---------------------------------------------------------------------------

async function startReviewServerHTTP(
  options: ReviewServerOptions
): Promise<ReviewServerResult> {
  const resp = await fetch(`${SERVER_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "review",
      data: {
        rawPatch: options.rawPatch,
        gitRef: options.gitRef,
        error: options.error,
        origin: options.origin,
        diffType: options.diffType,
        gitContext: options.gitContext,
        sharingEnabled: options.sharingEnabled,
        shareBaseUrl: options.shareBaseUrl,
        cwd: options.cwd,
      },
    }),
  });

  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `Failed to submit review session: ${err.error ?? resp.statusText}`
    );
  }

  const { url: serverUrl, port } = (await resp.json()) as {
    url: string;
    port: number;
  };

  const remote = isRemoteSession();
  if (options.onReady) options.onReady(serverUrl, remote, port);

  return {
    port,
    url: serverUrl,
    isRemote: remote,
    waitForDecision: () =>
      fetch(`${SERVER_URL}/api/wait`).then(
        (r) => r.json()
      ) as Promise<ReviewDecision>,
    stop: () => {},
  };
}

async function startAnnotateServerHTTP(
  options: AnnotateServerOptions
): Promise<AnnotateServerResult> {
  const resp = await fetch(`${SERVER_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "annotate",
      data: {
        markdown: options.markdown,
        filePath: options.filePath,
        origin: options.origin,
        sharingEnabled: options.sharingEnabled,
        shareBaseUrl: options.shareBaseUrl,
      },
    }),
  });

  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `Failed to submit annotate session: ${err.error ?? resp.statusText}`
    );
  }

  const { url: serverUrl, port } = (await resp.json()) as {
    url: string;
    port: number;
  };

  const remote = isRemoteSession();
  if (options.onReady) options.onReady(serverUrl, remote, port);

  return {
    port,
    url: serverUrl,
    isRemote: remote,
    waitForDecision: () =>
      fetch(`${SERVER_URL}/api/wait`).then(
        (r) => r.json()
      ) as Promise<AnnotateDecision>,
    stop: () => {},
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const PlannotatorPlugin: Plugin = async (ctx) => {
  // Ensure the persistent server is running before registering tools
  await ensureServerRunning();

  async function getSharingEnabled(): Promise<boolean> {
    try {
      const response = await ctx.client.config.get({
        query: { directory: ctx.directory },
      });
      // @ts-ignore - share config may exist
      const share = response?.data?.share;
      if (share !== undefined) return share !== "disabled";
    } catch {}
    return process.env.PLANNOTATOR_SHARE !== "disabled";
  }

  function getShareBaseUrl(): string | undefined {
    return process.env.PLANNOTATOR_SHARE_URL || undefined;
  }

  function getPlanTimeoutSeconds(): number | null {
    const raw = process.env.PLANNOTATOR_PLAN_TIMEOUT_SECONDS?.trim();
    if (!raw) return DEFAULT_PLAN_TIMEOUT_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(
        `[Plannotator] Invalid PLANNOTATOR_PLAN_TIMEOUT_SECONDS="${raw}". Using default ${DEFAULT_PLAN_TIMEOUT_SECONDS}s.`
      );
      return DEFAULT_PLAN_TIMEOUT_SECONDS;
    }
    if (parsed === 0) return null;
    return parsed;
  }

  return {
    config: async (opencodeConfig) => {
      const existingPrimaryTools =
        opencodeConfig.experimental?.primary_tools ?? [];
      const requiredPrimaryTools = [
        "submit_plan",
        "plannotator_review",
        "plannotator_annotate",
      ];
      const missingPrimaryTools = requiredPrimaryTools.filter(
        (toolName) => !existingPrimaryTools.includes(toolName)
      );
      if (missingPrimaryTools.length > 0) {
        opencodeConfig.experimental = {
          ...opencodeConfig.experimental,
          primary_tools: [...existingPrimaryTools, ...missingPrimaryTools],
        };
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const existingSystem = output.system.join("\n").toLowerCase();
      if (
        existingSystem.includes("title generator") ||
        existingSystem.includes("generate a title")
      ) {
        return;
      }

      try {
        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID },
        });
        const messages = messagesResponse.data;

        let lastUserAgent: string | undefined;
        if (messages) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.info.role === "user") {
              // @ts-ignore - UserMessage has agent field
              lastUserAgent = msg.info.agent;
              break;
            }
          }
        }

        if (!lastUserAgent) return;
        if (lastUserAgent === "build") return;

        const agentsResponse = await ctx.client.app.agents({
          query: { directory: ctx.directory },
        });
        const agents = agentsResponse.data;
        const agent = agents?.find(
          (a: { name: string }) => a.name === lastUserAgent
        );
        // @ts-ignore - Agent has mode field
        if (agent?.mode === "subagent") return;
      } catch {
        return;
      }

      output.system.push(`
## Plan Submission

When you have completed your plan, you MUST call the \`submit_plan\` tool to submit it for user review.
The user will be able to:
- Review your plan visually in a dedicated UI
- Annotate specific sections with feedback
- Approve the plan to proceed with implementation
- Request changes with detailed feedback

If your plan is rejected, you will receive the user's annotated feedback. Revise your plan
based on their feedback and call submit_plan again.

Do NOT proceed with implementation until your plan is approved.
`);
    },

    event: async ({ event }) => {
      const isCommandEvent =
        event.type === "command.executed" ||
        event.type === "tui.command.execute";

      // @ts-ignore
      const commandName =
        event.properties?.name || event.command || event.payload?.name;
      const isReviewCommand = commandName === "plannotator-review";

      if (isCommandEvent && isReviewCommand) {
        ctx.client.app.log({ level: "info", message: "Opening code review UI..." });

        // @ts-ignore
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        const message = await runPlannotatorReviewTool(
          { diff_type: "uncommitted" },
          {
            sessionID,
            messageID: "",
            agent: "build",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          },
          {
            client: ctx.client,
            directory: ctx.directory,
            htmlContent: "",
            getSharingEnabled,
            getShareBaseUrl,
          },
          {
            ...defaultReviewToolDependencies,
            startReviewServer: startReviewServerHTTP,
            onReady: handleReviewServerReady,
          }
        );

        ctx.client.app.log({ level: "info", message });
      }
    },

    tool: {
      submit_plan: tool({
        description:
          "Submit your completed plan for interactive user review. The user can annotate, approve, or request changes. Call this when you have finished creating your implementation plan.",
        args: {
          plan: tool.schema
            .string()
            .describe("The complete implementation plan in markdown format"),
          summary: tool.schema
            .string()
            .describe("A brief 1-2 sentence summary of what the plan accomplishes"),
          commit_message: tool.schema
            .string()
            .describe(
              "A commit message summarizing what has changed since the previous version of this plan. If this is a revision of a previously rejected plan, explain what feedback was addressed."
            ),
        },

        async execute(args, context) {
          // Submit plan session to persistent server
          const resp = await fetch(`${SERVER_URL}/api/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "plan",
              data: {
                plan: args.plan,
                origin: "opencode",
                sharingEnabled: await getSharingEnabled(),
                shareBaseUrl: getShareBaseUrl(),
                commitMessage: args.commit_message,
              },
            }),
          });

          if (!resp.ok) {
            const err = (await resp.json().catch(() => ({}))) as {
              error?: string;
            };
            return `[Plannotator] Failed to submit plan: ${err.error ?? resp.statusText}`;
          }

          const {
            url: serverUrl,
            port,
          } = (await resp.json()) as {
            url: string;
            port: number;
          };

          const remote = isRemoteSession();
          handleServerReady(serverUrl, remote, port);

          if (remote && (await getSharingEnabled())) {
            await writeRemoteShareLink(
              args.plan,
              getShareBaseUrl(),
              "review the plan",
              "plan only"
            ).catch(() => {});
          }

          // Long-poll for decision with optional timeout
          const timeoutSeconds = getPlanTimeoutSeconds();

          let result: PlanDecision;
          if (timeoutSeconds === null) {
            const r = await fetch(`${SERVER_URL}/api/wait`);
            result = (await r.json()) as PlanDecision;
          } else {
            const r = await fetch(
              `${SERVER_URL}/api/wait`,
              { signal: AbortSignal.timeout(timeoutSeconds * 1000) }
            ).catch((err) => {
              if (err.name === "TimeoutError" || err.name === "AbortError")
                return null;
              throw err;
            });

            if (!r) {
              return `[Plannotator] No response within ${timeoutSeconds} seconds. Port released automatically. Please call submit_plan again.`;
            }
            result = (await r.json()) as PlanDecision;
          }

          if (result.cancelled) return "Plan review cancelled by user.";

          if (result.approved) {
            const shouldSwitchAgent =
              result.agentSwitch && result.agentSwitch !== "disabled";
            const targetAgent = result.agentSwitch || "build";

            if (shouldSwitchAgent) {
              try {
                await ctx.client.tui.executeCommand({
                  body: { command: "agent_cycle" },
                });
              } catch {}

              try {
                await ctx.client.session.prompt({
                  path: { id: context.sessionID },
                  body: {
                    agent: targetAgent,
                    noReply: true,
                    parts: [{ type: "text", text: "Proceed with implementation" }],
                  },
                });
              } catch {}
            }

            if (result.feedback) {
              return `Plan approved with notes!

Plan Summary: ${args.summary}
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}

## Implementation Notes

The user approved your plan but added the following notes to consider during implementation:

${result.feedback}

Proceed with implementation, incorporating these notes where applicable.`;
            }

            return `Plan approved!

Plan Summary: ${args.summary}
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}`;
          } else {
            return `Plan needs revision.
${result.savedPath ? `\nSaved to: ${result.savedPath}` : ""}

The user has requested changes to your plan. Please review their feedback below and revise your plan accordingly.

## User Feedback

${result.feedback}

---

Please revise your plan based on this feedback and call \`submit_plan\` again when ready.`;
          }
        },
      }),

      plannotator_review: tool({
        description:
          "Present git diff changes to the user for live code review and feedback. Use this whenever you want to show code changes to the user so they can review and annotate specific lines.",
        args: {
          diff_type: tool.schema
            .enum(REVIEW_TOOL_DIFF_TYPES)
            .optional()
            .describe(
              "Diff to review: uncommitted, staged, unstaged, last-commit, or branch"
            ),
        },
        async execute(args, context) {
          return runPlannotatorReviewTool(
            args,
            context,
            {
              client: ctx.client,
              directory: ctx.directory,
              htmlContent: "",
              getSharingEnabled,
              getShareBaseUrl,
            },
            {
              ...defaultReviewToolDependencies,
              startReviewServer: startReviewServerHTTP,
              onReady: handleReviewServerReady,
            }
          );
        },
      }),

      plannotator_annotate: tool({
        description:
          "Present a markdown document to the user for live annotation and feedback. Use this whenever you want to show a markdown file to the user so they can review, annotate, and give corrections in real time.",
        args: {
          file_path: tool.schema
            .string()
            .describe("Path to the markdown file to present for annotation"),
        },
        async execute(args, context) {
          return runPlannotatorAnnotateTool(
            args,
            context,
            {
              client: ctx.client,
              directory: ctx.directory,
              htmlContent: "",
              getSharingEnabled,
              getShareBaseUrl,
            },
            {
              ...defaultAnnotateToolDependencies,
              startAnnotateServer: startAnnotateServerHTTP,
              onReady: handleAnnotateServerReady,
            }
          );
        },
      }),
    },
  };
};

export default PlannotatorPlugin;
