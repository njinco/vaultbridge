import { type App, Modal, Notice, Setting } from "obsidian";
import type { RemotelySavePluginSettings } from "./baseTypes";

export class SettingsImportModal extends Modal {
  constructor(
    app: App,
    private readonly settings: Partial<RemotelySavePluginSettings>,
    private readonly applySettings: () => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Review settings import" });
    contentEl.createEl("p", {
      text: "Only import settings from a source you trust. These changes can redirect cloud sync, replace credentials, or change how files are overwritten and deleted.",
    });
    const list = contentEl.createEl("ul");
    for (const [key, value] of Object.entries(this.settings)) {
      let summary = key;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        summary += `: ${Object.keys(value).join(", ")}`;
        // Show the destination without userinfo, paths, queries, or SAS tokens.
        for (const field of [
          "address",
          "s3Endpoint",
          "api",
          "containerSasUrl",
        ]) {
          const address = (value as Record<string, unknown>)[field];
          if (typeof address === "string" && address !== "") {
            try {
              const url = new URL(address);
              summary += ` (${field}: ${url.origin})`;
            } catch {
              summary += ` (${field}: custom address)`;
            }
          }
        }
      } else if (
        typeof value === "boolean" ||
        typeof value === "number" ||
        [
          "serviceType",
          "syncDirection",
          "conflictAction",
          "encryptionMethod",
          "deleteToWhere",
        ].includes(key)
      ) {
        summary += `: ${value}`;
      } else if (Array.isArray(value)) {
        summary += `: ${value.length} entries`;
      } else {
        summary += ": value hidden";
      }
      list.createEl("li", { text: summary });
    }
    contentEl.createEl("p", {
      text: "Passwords and tokens are hidden. Automatic sync settings take full effect after you reload the plugin.",
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close())
      )
      .addButton((button) =>
        button
          .setButtonText("Import settings")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.applySettings();
              this.close();
              new Notice("Settings imported.");
            } catch {
              new Notice(
                "Settings were not imported. Wait for any active sync to finish and try again."
              );
              button.setDisabled(false);
            }
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
