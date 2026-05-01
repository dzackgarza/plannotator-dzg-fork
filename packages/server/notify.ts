import { spawn } from "node:child_process";
import process from "node:process";

type ReviewNotification = {
  daemonUrl: string;
  documentTitle: string;
};

type NotificationCommand = {
  command: string;
  args: string[];
};

const APP_NAME = "Plannotator";

function assertNonEmptyString(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function buildWindowsToastScript(): string {
  return [
    "param(",
    "  [string]$title,",
    "  [string]$subtitle,",
    "  [string]$body",
    ")",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$escapedTitle = [System.Security.SecurityElement]::Escape($title)",
    "$escapedSubtitle = [System.Security.SecurityElement]::Escape($subtitle)",
    "$escapedBody = [System.Security.SecurityElement]::Escape($body)",
    '$toastXml = @"',
    "<toast>",
    "  <visual>",
    '    <binding template="ToastGeneric">',
    "      <text>$escapedTitle</text>",
    "      <text>$escapedSubtitle</text>",
    "      <text>$escapedBody</text>",
    "    </binding>",
    "  </visual>",
    "</toast>",
    '"@',
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml($toastXml)",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Windows PowerShell')",
    "$notifier.Show($toast)",
  ].join("\n");
}

function buildNotificationCommand(
  notification: ReviewNotification,
): NotificationCommand {
  const documentTitle = assertNonEmptyString(
    notification.documentTitle.trim(),
    "Notification documentTitle",
  );
  const daemonUrl = assertNonEmptyString(
    notification.daemonUrl.trim(),
    "Notification daemonUrl",
  );

  if (process.platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        [
          "on run argv",
          "set notificationTitle to item 1 of argv",
          "set notificationSubtitle to item 2 of argv",
          "set notificationBody to item 3 of argv",
          "display notification notificationBody with title notificationTitle subtitle notificationSubtitle",
          "end run",
        ].join("\n"),
        APP_NAME,
        documentTitle,
        daemonUrl,
      ],
    };
  }

  if (process.platform === "linux") {
    return {
      command: "notify-send",
      args: [`${APP_NAME}: ${documentTitle}`, daemonUrl],
    };
  }

  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        buildWindowsToastScript(),
        APP_NAME,
        documentTitle,
        daemonUrl,
      ],
    };
  }

  throw new Error(`Unsupported notification platform ${JSON.stringify(process.platform)}.`);
}

async function runNotificationCommand(
  notificationCommand: NotificationCommand,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(notificationCommand.command, notificationCommand.args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let stderr = "";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const rejectWith = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      rejectPromise(error);
    };

    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      rejectWith(
        new Error(
          `Failed to start notification command ${JSON.stringify(notificationCommand.command)}: ${message}`,
        ),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (code === 0) {
        settled = true;
        resolvePromise();
        return;
      }

      const details = [
        `Notification command ${JSON.stringify(notificationCommand.command)} exited unsuccessfully.`,
        `code=${String(code)}`,
        `signal=${String(signal)}`,
      ];
      if (stderr.trim().length > 0) {
        details.push(`stderr=${stderr.trim()}`);
      }

      rejectWith(new Error(details.join(" ")));
    });
  });
}

export async function notifyDocumentEnteredReview(
  notification: ReviewNotification,
): Promise<void> {
  if (process.env.PLANNOTATOR_NOTIFY === "0") {
    return;
  }

  await runNotificationCommand(buildNotificationCommand(notification));
}
