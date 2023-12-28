import { 
    ItemView, 
    WorkspaceLeaf 
} from "obsidian";

export const VIEW_TYPE_HISTORY = "history-view";

export class HistoryView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_HISTORY;
  }

  getDisplayText() {
    return "Sync History";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.createEl("h4", { text: "Sync History" });
  }

  async onClose() {
    
  }
}