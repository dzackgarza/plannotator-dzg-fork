/**
 * Export Modal for local annotations and notes-app saves.
 */

import React, { useState, useEffect } from "react";
import { getObsidianSettings, getEffectiveVaultPath } from "../utils/obsidian";
import { getBearSettings } from "../utils/bear";
import { wrapFeedbackForAgent } from "../utils/parser";

type Tab = "annotations" | "notes";
type SaveTarget = "obsidian" | "bear";
type SaveStatus = "idle" | "saving" | "success" | "error";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  annotationsOutput: string;
  annotationCount: number;
  taterSprite?: React.ReactNode;
  markdown?: string;
  isApiMode?: boolean;
  initialTab?: Tab;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  annotationsOutput,
  annotationCount,
  taterSprite,
  markdown,
  isApiMode = false,
  initialTab,
}) => {
  const defaultTab: Tab = initialTab || "annotations";
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Record<SaveTarget, SaveStatus>>({
    obsidian: "idle",
    bear: "idle",
  });
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab || "annotations");
      setCopied(false);
      setSaveStatus({ obsidian: "idle", bear: "idle" });
      setSaveErrors({});
    }
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const showNotesTab = isApiMode && !!markdown;
  const obsidianSettings = getObsidianSettings();
  const bearSettings = getBearSettings();
  const effectiveVaultPath = getEffectiveVaultPath(obsidianSettings);
  const isObsidianReady =
    obsidianSettings.enabled && effectiveVaultPath.trim().length > 0;
  const isBearReady = bearSettings.enabled;

  const handleCopyAnnotations = async () => {
    try {
      await navigator.clipboard.writeText(wrapFeedbackForAgent(annotationsOutput));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const handleDownloadAnnotations = () => {
    const blob = new Blob([annotationsOutput], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "annotations.md";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveToNotes = async (target: SaveTarget) => {
    if (!markdown) return;

    setSaveStatus((prev) => ({ ...prev, [target]: "saving" }));
    setSaveErrors((prev) => {
      const next = { ...prev };
      delete next[target];
      return next;
    });

    const body: { obsidian?: object; bear?: object } = {};

    if (target === "obsidian") {
      body.obsidian = {
        vaultPath: effectiveVaultPath,
        folder: obsidianSettings.folder || "plannotator",
        plan: markdown,
        ...(obsidianSettings.filenameFormat && {
          filenameFormat: obsidianSettings.filenameFormat,
        }),
        ...(obsidianSettings.filenameSeparator &&
          obsidianSettings.filenameSeparator !== "space" && {
            filenameSeparator: obsidianSettings.filenameSeparator,
          }),
      };
    }

    if (target === "bear") {
      body.bear = { plan: markdown };
    }

    try {
      const response = await fetch("/api/save-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      const result = data.results?.[target];

      if (result?.success) {
        setSaveStatus((prev) => ({ ...prev, [target]: "success" }));
      } else {
        setSaveStatus((prev) => ({ ...prev, [target]: "error" }));
        setSaveErrors((prev) => ({
          ...prev,
          [target]: result?.error || "Save failed",
        }));
      }
    } catch {
      setSaveStatus((prev) => ({ ...prev, [target]: "error" }));
      setSaveErrors((prev) => ({ ...prev, [target]: "Save failed" }));
    }
  };

  const handleSaveAll = async () => {
    const targets: SaveTarget[] = [];
    if (isObsidianReady) targets.push("obsidian");
    if (isBearReady) targets.push("bear");
    await Promise.all(targets.map((target) => handleSaveToNotes(target)));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div
        className="bg-card border border-border rounded-xl w-full max-w-2xl flex flex-col max-h-[80vh] shadow-2xl relative"
        onClick={(event) => event.stopPropagation()}
      >
        {taterSprite}

        <div className="p-4 border-b border-border">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-sm">Export</h3>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {annotationCount} annotation{annotationCount !== 1 ? "s" : ""}
              </span>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {(showNotesTab || activeTab === "notes") && (
            <div className="flex gap-1 bg-muted rounded-lg p-1 mb-4">
              <button
                onClick={() => setActiveTab("annotations")}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === "annotations"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Annotations
              </button>
              {showNotesTab && (
                <button
                  onClick={() => setActiveTab("notes")}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    activeTab === "notes"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Notes
                </button>
              )}
            </div>
          )}

          {activeTab === "notes" && showNotesTab ? (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Save this plan to your notes app without approving or denying.
              </p>

              <div className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isObsidianReady ? "bg-success" : "bg-muted-foreground/30"
                      }`}
                    />
                    <span className="text-sm font-medium">Obsidian</span>
                  </div>
                  {isObsidianReady ? (
                    <button
                      onClick={() => handleSaveToNotes("obsidian")}
                      disabled={saveStatus.obsidian === "saving"}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        saveStatus.obsidian === "success"
                          ? "bg-success/15 text-success"
                          : saveStatus.obsidian === "error"
                            ? "bg-destructive/15 text-destructive"
                            : saveStatus.obsidian === "saving"
                              ? "bg-muted text-muted-foreground opacity-50"
                              : "bg-primary text-primary-foreground hover:opacity-90"
                      }`}
                    >
                      {saveStatus.obsidian === "saving"
                        ? "Saving..."
                        : saveStatus.obsidian === "success"
                          ? "Saved"
                          : saveStatus.obsidian === "error"
                            ? "Failed"
                            : "Save"}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Not configured
                    </span>
                  )}
                </div>
                {isObsidianReady && (
                  <div className="text-[10px] text-muted-foreground/70">
                    {effectiveVaultPath}/{obsidianSettings.folder || "plannotator"}/
                  </div>
                )}
                {!isObsidianReady && (
                  <div className="text-[10px] text-muted-foreground/70">
                    Enable in Settings &gt; Saving &gt; Obsidian
                  </div>
                )}
                {saveErrors.obsidian && (
                  <div className="text-[10px] text-destructive">
                    {saveErrors.obsidian}
                  </div>
                )}
              </div>

              <div className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isBearReady ? "bg-success" : "bg-muted-foreground/30"
                      }`}
                    />
                    <span className="text-sm font-medium">Bear</span>
                  </div>
                  {isBearReady ? (
                    <button
                      onClick={() => handleSaveToNotes("bear")}
                      disabled={saveStatus.bear === "saving"}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        saveStatus.bear === "success"
                          ? "bg-success/15 text-success"
                          : saveStatus.bear === "error"
                            ? "bg-destructive/15 text-destructive"
                            : saveStatus.bear === "saving"
                              ? "bg-muted text-muted-foreground opacity-50"
                              : "bg-primary text-primary-foreground hover:opacity-90"
                      }`}
                    >
                      {saveStatus.bear === "saving"
                        ? "Saving..."
                        : saveStatus.bear === "success"
                          ? "Saved"
                          : saveStatus.bear === "error"
                            ? "Failed"
                            : "Save"}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Not configured
                    </span>
                  )}
                </div>
                {!isBearReady && (
                  <div className="text-[10px] text-muted-foreground/70">
                    Enable in Settings &gt; Saving &gt; Bear
                  </div>
                )}
                {saveErrors.bear && (
                  <div className="text-[10px] text-destructive">
                    {saveErrors.bear}
                  </div>
                )}
              </div>

              {isObsidianReady && isBearReady && (
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveAll}
                    disabled={
                      saveStatus.obsidian === "saving" ||
                      saveStatus.bear === "saving"
                    }
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    Save All
                  </button>
                </div>
              )}
            </div>
          ) : (
            <pre className="bg-muted rounded-lg p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
              {annotationsOutput}
            </pre>
          )}
        </div>

        {activeTab === "annotations" && (
          <div className="p-4 border-t border-border flex justify-end gap-2">
            <button
              onClick={handleCopyAnnotations}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={handleDownloadAnnotations}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Download Annotations
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
