/**
 * Plannotator Plugin for OpenCode
 *
 * Provides a Claude Code-style planning experience with interactive plan review.
 * When the agent calls submit_plan, the Plannotator UI opens for the user to
 * annotate, approve, or request changes to the plan.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (devcontainer, SSH)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_PLAN_TIMEOUT_SECONDS - Max wait for submit_plan approval (default: 345600, set 0 to disable)
 *
 * @packageDocumentation
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import {
  REVIEW_TOOL_DIFF_TYPES,
  runPlannotatorAnnotateTool,
  runPlannotatorReviewTool,
  defaultAnnotateToolDependencies,
  defaultReviewToolDependencies,
} from "./tool-helpers";

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "./review-editor.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

const DEFAULT_PLAN_TIMEOUT_SECONDS = 345_600; // 96 hours

export const PlannotatorPlugin: Plugin = async (ctx) => {
  // Helper to determine if sharing is enabled (lazy evaluation)
  // Priority: OpenCode config > env var > default (enabled)
  async function getSharingEnabled(): Promise<boolean> {
    try {
      const response = await ctx.client.config.get({ query: { directory: ctx.directory } });
      // Config is wrapped in response.data
      // @ts-ignore - share config may exist
      const share = response?.data?.share;
      if (share !== undefined) {
        return share !== "disabled";
      }
    } catch {
      // Config read failed, fall through to env var
    }
    // Fall back to env var
    return process.env.PLANNOTATOR_SHARE !== "disabled";
  }

  // Custom share portal URL for self-hosting
  function getShareBaseUrl(): string | undefined {
    return process.env.PLANNOTATOR_SHARE_URL || undefined;
  }

  /**
   * submit_plan wait timeout in seconds.
   * - unset: default to 96h
   * - 0: disable timeout
   * - invalid/negative: fall back to default
   */
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
    // Register submit_plan as primary-only tool (hidden from sub-agents)
    config: async (opencodeConfig) => {
      const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
      const requiredPrimaryTools = [
        "submit_plan",
        "plannotator_review",
        "plannotator_annotate",
      ];
      const missingPrimaryTools = requiredPrimaryTools.filter(
        (toolName) => !existingPrimaryTools.includes(toolName),
      );
      if (missingPrimaryTools.length > 0) {
        opencodeConfig.experimental = {
          ...opencodeConfig.experimental,
          primary_tools: [...existingPrimaryTools, ...missingPrimaryTools],
        };
      }
    },

    // Inject planning instructions into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      // Skip for title generation requests
      const existingSystem = output.system.join("\n").toLowerCase();
      if (existingSystem.includes("title generator") || existingSystem.includes("generate a title")) {
        return;
      }

      try {
        // Fetch session messages to determine current agent
        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID }
        });
        const messages = messagesResponse.data;

        // Find last user message (reverse iteration)
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

        // Skip if agent detection fails (safer)
        if (!lastUserAgent) return;

        // Hardcoded exclusion: build agent
        if (lastUserAgent === "build") return;

        // Dynamic exclusion: check agent mode via API
        const agentsResponse = await ctx.client.app.agents({
          query: { directory: ctx.directory }
        });
        const agents = agentsResponse.data;
        const agent = agents?.find((a: { name: string }) => a.name === lastUserAgent);

        // Skip if agent is a sub-agent
        // @ts-ignore - Agent has mode field
        if (agent?.mode === "subagent") return;

      } catch {
        // Skip injection on any error (safer)
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

    // Listen for /plannotator-review command
    event: async ({ event }) => {
      // Check for command execution event
      const isCommandEvent =
        event.type === "command.executed" ||
        event.type === "tui.command.execute";

      // @ts-ignore - Event structure: event.properties.name for command.executed
      const commandName = event.properties?.name || event.command || event.payload?.name;
      const isReviewCommand = commandName === "plannotator-review";

      if (isCommandEvent && isReviewCommand) {
        ctx.client.app.log({
          level: "info",
          message: "Opening code review UI...",
        });

        // @ts-ignore - Event properties contain sessionID for command.executed events
        const sessionID = event.properties?.sessionID;
        if (!sessionID) {
          return;
        }

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
            htmlContent: reviewHtmlContent,
            getSharingEnabled,
            getShareBaseUrl,
          },
          {
            ...defaultReviewToolDependencies,
            startReviewServer,
            onReady: handleReviewServerReady,
          },
        );

        ctx.client.app.log({
          level: "info",
          message,
        });
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
            .describe("A commit message summarizing what has changed since the previous version of this plan. If this is a revision of a previously rejected plan, explain what feedback was addressed."),
        },

        async execute(args, context) {
          const server = await startPlannotatorServer({
            plan: args.plan,
            origin: "opencode",
            sharingEnabled: await getSharingEnabled(),
            shareBaseUrl: getShareBaseUrl(),
            htmlContent,
            opencodeClient: ctx.client,
            commitMessage: args.commit_message,
            onReady: async (url, isRemote, port) => {
              handleServerReady(url, isRemote, port);
              if (isRemote && await getSharingEnabled()) {
                await writeRemoteShareLink(args.plan, getShareBaseUrl(), "review the plan", "plan only").catch(() => {});
              }
            },
          });

          const timeoutSeconds = getPlanTimeoutSeconds();
          const timeoutMs = timeoutSeconds === null ? null : timeoutSeconds * 1000;

          const result = timeoutMs === null
            ? await server.waitForDecision()
            : await new Promise<Awaited<ReturnType<typeof server.waitForDecision>>>((resolve) => {
                const timeoutId = setTimeout(
                  () =>
                    resolve({
                      approved: false,
                      feedback: `[Plannotator] No response within ${timeoutSeconds} seconds. Port released automatically. Please call submit_plan again.`,
                    }),
                  timeoutMs
                );

                server.waitForDecision().then((r) => {
                  clearTimeout(timeoutId);
                  resolve(r);
                });
              });
          
          // Server will gracefully shut down via /api/shutdown call from UI
          // Fallback stop in case UI disconnects without calling it
          setTimeout(() => server.stop(), 10000);

          if (result.cancelled) {
            return `Plan review cancelled by user.`;
          }

          if (result.approved) {
            // Check agent switch setting (defaults to 'build' if not set)
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== 'disabled';
            const targetAgent = result.agentSwitch || 'build';

            if (shouldSwitchAgent) {
              // Switch TUI display to target agent
              try {
                await ctx.client.tui.executeCommand({
                  body: { command: "agent_cycle" },
                });
              } catch {
                // Silently fail
              }

              // Create a user message with target agent using noReply: true
              // This ensures the message is created BEFORE we return from the tool,
              // so the current loop's next iteration will see it.
              // noReply: true means we don't wait for a new loop to complete.
              try {
                await ctx.client.session.prompt({
                  path: { id: context.sessionID },
                  body: {
                    agent: targetAgent,
                    noReply: true,
                    parts: [{ type: "text", text: "Proceed with implementation" }],
                  },
                });
              } catch {
                // Silently fail if session is busy
              }
            }

            // If user approved with annotations, include them as notes for implementation
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
            .describe("Diff to review: uncommitted, staged, unstaged, last-commit, or branch"),
        },
        async execute(args, context) {
          return runPlannotatorReviewTool(
            args,
            context,
            {
              client: ctx.client,
              directory: ctx.directory,
              htmlContent: reviewHtmlContent,
              getSharingEnabled,
              getShareBaseUrl,
            },
            {
              ...defaultReviewToolDependencies,
              startReviewServer,
              onReady: handleReviewServerReady,
            },
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
              htmlContent,
              getSharingEnabled,
              getShareBaseUrl,
            },
            {
              ...defaultAnnotateToolDependencies,
              startAnnotateServer,
              onReady: handleAnnotateServerReady,
            },
          );
        },
      }),
    },
  };
};

export default PlannotatorPlugin;
