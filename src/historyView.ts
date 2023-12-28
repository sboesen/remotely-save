import { 
    App,
    ItemView, 
    WorkspaceLeaf 
} from "obsidian";
import RemotelySavePlugin from "./main";
import { MetadataOnRemote } from "./metadataOnRemote";

export const VIEW_TYPE_HISTORY = "history-view";

export class HistoryView extends ItemView {
    plugin: RemotelySavePlugin

    constructor(leaf: WorkspaceLeaf, plugin: RemotelySavePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return VIEW_TYPE_HISTORY;
    }

    getDisplayText() {
        return "Sync History";
    }

    async getHistory() {
        // Fetch metadata from remote
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.createEl("h4", { text: "Sync History" });

        container.createEl("p", { text: "Last refreshed x minutes ago." });
        
        const refreshButton = container.createEl("button", { text: "Refresh" });
        refreshButton.addEventListener("click", (click) => this.getHistory());

        const syncButton = container.createEl("button", { text: "Sync" });
        syncButton.addEventListener("click", (click) => this.plugin.syncRun("manual"));
        
    }

    async onClose() {

    }
}