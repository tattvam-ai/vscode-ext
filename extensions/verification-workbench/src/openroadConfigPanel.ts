/*---------------------------------------------------------------------------------------------
 *  OpenROAD Flow Configuration Panel (WebviewPanel)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

type FlowConfig = {
	flowHome: string;
	designConfig: string;
	platform: string;
	target: string;
	resultsRoot: string;
	envPreset: "none" | "docker" | "conda";
};

export class OpenroadConfigPanel {
	public static current: OpenroadConfigPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];

	private constructor(panel: vscode.WebviewPanel) {
		this.panel = panel;
	}

	public static async createOrShow(context: vscode.ExtensionContext) {
		const column = vscode.ViewColumn.Active;
		if (OpenroadConfigPanel.current) {
			OpenroadConfigPanel.current.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"openroadConfigureFlow",
			"Configure OpenROAD Flow",
			column,
			{ enableScripts: true }
		);

		const instance = new OpenroadConfigPanel(panel);
		OpenroadConfigPanel.current = instance;
		instance.initialize(context);
	}

	private async initialize(context: vscode.ExtensionContext) {
		const cfg = vscode.workspace.getConfiguration();
		const initial: FlowConfig = {
			flowHome: cfg.get<string>("openroad.flow.flowHome", ""),
			designConfig: cfg.get<string>("openroad.flow.designConfig", ""),
			platform: cfg.get<string>("openroad.flow.platform", ""),
			target: cfg.get<string>("openroad.flow.target", "finish"),
			resultsRoot: cfg.get<string>("openroad.flow.resultsRoot", ""),
			envPreset: (cfg.get<string>("openroad.flow.envPreset", "none") as any) || "none",
		};

		this.panel.webview.html = this.getHtml(initial);

		const d1 = this.panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg?.type) {
				case "browseFolder": {
					const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
					if (picked && picked.length > 0) {
						this.panel.webview.postMessage({ type: "folderPicked", field: msg.field, value: picked[0].fsPath });
					}
					break;
				}
				case "browseFile": {
					const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { "Make Config": ["mk"], "All": ["*"] } });
					if (picked && picked.length > 0) {
						this.panel.webview.postMessage({ type: "filePicked", field: msg.field, value: picked[0].fsPath });
					}
					break;
				}
				case "save": {
					const values = msg?.values as FlowConfig;
					await cfg.update("openroad.flow.flowHome", values.flowHome, vscode.ConfigurationTarget.Workspace);
					await cfg.update("openroad.flow.designConfig", values.designConfig, vscode.ConfigurationTarget.Workspace);
					await cfg.update("openroad.flow.platform", values.platform, vscode.ConfigurationTarget.Workspace);
					await cfg.update("openroad.flow.target", values.target, vscode.ConfigurationTarget.Workspace);
					await cfg.update("openroad.flow.resultsRoot", values.resultsRoot, vscode.ConfigurationTarget.Workspace);
					await cfg.update("openroad.flow.envPreset", values.envPreset, vscode.ConfigurationTarget.Workspace);
					vscode.window.showInformationMessage("OpenROAD flow configuration saved.");
					this.panel.dispose();
					break;
				}
				case "cancel": {
					this.panel.dispose();
					break;
				}
			}
		});
		const d2 = this.panel.onDidDispose(() => this.dispose());
		this.disposables.push(d1, d2);
	}

	private dispose() {
		OpenroadConfigPanel.current = undefined;
		while (this.disposables.length) {
			const d = this.disposables.pop();
			try { d?.dispose(); } catch { }
		}
	}

	private getHtml(initial: FlowConfig): string {
		const escape = (s: string) => String(s || "").replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] as string));
		return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configure OpenROAD Flow</title>
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
        .row { display: grid; grid-template-columns: 140px 1fr auto; gap: 8px; align-items: center; margin-bottom: 10px; }
        input, select { width: 100%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
        button { padding: 6px 10px; }
        .actions { margin-top: 16px; display: flex; gap: 8px; }
    </style>
</head>
<body>
    <div class="row">
        <label>FLOW_HOME</label>
        <input id="flowHome" value="${escape(initial.flowHome)}" placeholder="/path/to/OpenROAD-flow-scripts" />
        <button id="browseFlowHome">Browse</button>
    </div>
    <div class="row">
        <label>DESIGN_CONFIG</label>
        <input id="designConfig" value="${escape(initial.designConfig)}" placeholder="/abs/path/to/config.mk" />
        <button id="browseDesignConfig">Browse</button>
    </div>

    <div class="row">
        <label>PLATFORM</label>
        <input id="platform" value="${escape(initial.platform)}" placeholder="e.g., sky130hd" />
        <span></span>
    </div>
    <div class="row">
        <label>Target</label>
        <select id="target">
            ${["finish", "synth", "floorplan", "place", "cts", "route", "gui_final"].map(t => `<option value="${t}" ${t === initial.target ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <span></span>
    </div>
    <div class="row">
        <label>Results Root</label>
        <input id="resultsRoot" value="${escape(initial.resultsRoot)}" placeholder="(leave empty for autodetect)" />
        <button id="browseResultsRoot">Browse</button>
    </div>
    <div class="row">
        <label>Env Preset</label>
        <select id="envPreset">
            ${["none", "docker", "conda"].map(v => `<option value="${v}" ${v === initial.envPreset ? "selected" : ""}>${v}</option>`).join("")}
        </select>
        <span></span>
    </div>

    <div class="actions">
        <button id="save">Save</button>
        <button id="cancel">Cancel</button>
    </div>

    <script nonce="abc">
        const vscode = acquireVsCodeApi();
        function val(id){ return document.getElementById(id).value; }
        document.getElementById('browseFlowHome').onclick = () => vscode.postMessage({ type: 'browseFolder', field: 'flowHome' });
        document.getElementById('browseDesignConfig').onclick = () => vscode.postMessage({ type: 'browseFile', field: 'designConfig' });
        document.getElementById('browseResultsRoot').onclick = () => vscode.postMessage({ type: 'browseFolder', field: 'resultsRoot' });
        document.getElementById('save').onclick = () => {
            vscode.postMessage({ type: 'save', values: {
                flowHome: val('flowHome'),
                designConfig: val('designConfig'),
                platform: val('platform'),
                target: document.getElementById('target').value,
                resultsRoot: val('resultsRoot'),
                envPreset: document.getElementById('envPreset').value,
            }});
        };
        document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
        window.addEventListener('message', (e) => {
            const m = e.data || {};
            if (m.type === 'folderPicked' || m.type === 'filePicked') {
                const el = document.getElementById(m.field);
                if (el) el.value = m.value || '';
            }
        });
    </script>
</body>
</html>`;
	}
}


