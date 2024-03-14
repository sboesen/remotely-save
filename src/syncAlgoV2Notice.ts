import { App, Modal, Setting } from "obsidian";
import type { I18n } from "./i18n";

export class SyncAlgoV2Modal extends Modal {
  result: boolean;
  onSubmit: (result: boolean) => void;
  i18n: I18n;

  constructor(app: App, i18n: I18n, onSubmit: (result: boolean) => void) {
    super(app);
    this.i18n = i18n;
    this.result = false;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    let { contentEl } = this;

    contentEl.createEl("h2", {
      text: this.i18n.t("syncalgov2_title"),
    });

    this.i18n.t("syncalgov2_texts")
      .split("\n")
      .forEach((val) => {
        contentEl.createEl("p", {
          text: val,
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(this.i18n.t("syncalgov2_button_agree"));
        button.onClick(async () => {
          this.result = true;
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText(this.i18n.t("syncalgov2_button_disagree"));
        button.onClick(() => {
          this.close();
        });
      });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();

    this.onSubmit(this.result);
  }
}
