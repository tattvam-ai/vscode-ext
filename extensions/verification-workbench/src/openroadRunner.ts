/*---------------------------------------------------------------------------------------------
 *  OpenROAD Flow Runner: executes make commands and manages output
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";

export class OpenroadRunner implements vscode.Disposable {
	private static current: OpenroadRunner | undefined;
	private process: ChildProcess | undefined;
	private outputChannel: vscode.OutputChannel;
	private disposables: vscode.Disposable[] = [];
	private outputBuffer: string = "";

	private constructor() {
		this.outputChannel = vscode.window.createOutputChannel("OpenROAD Flow");
	}

	public static getInstance(): OpenroadRunner {
		if (!OpenroadRunner.current) {
			OpenroadRunner.current = new OpenroadRunner();
		}
		return OpenroadRunner.current;
	}

	public async runFlow(): Promise<void> {
		if (this.process) {
			vscode.window.showWarningMessage("OpenROAD flow is already running. Stop it first.");
			return;
		}

		const cfg = vscode.workspace.getConfiguration();
		const flowHome = cfg.get<string>("openroad.flow.flowHome", "");
		const designConfig = cfg.get<string>("openroad.flow.designConfig", "");
		const target = cfg.get<string>("openroad.flow.target", "");

		if (!flowHome || !designConfig) {
			vscode.window.showErrorMessage("OpenROAD flow not configured. Run 'OpenROAD: Configure Flow' first.");
			return;
		}

		// Build make command
		const args = ["-C", flowHome];
		if (target) {
			args.push(target);
		}
		args.push(`DESIGN_CONFIG=${designConfig}`);

		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine(`Running: make ${args.join(" ")}`);
		this.outputChannel.appendLine("");

		// Start process
		this.process = spawn("make", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env }
		});

		// Stream output
		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => {
				const text = data.toString();
				this.outputBuffer += text;
				this.outputChannel.append(text);
			});
		}

		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => {
				const text = data.toString();
				this.outputBuffer += text;
				this.outputChannel.append(text);
			});
		}

		this.process.on("close", async (code: number | null) => {
			this.outputChannel.appendLine("");
			if (code === 0) {
				this.outputChannel.appendLine("✅ OpenROAD flow completed successfully!");
				vscode.window.showInformationMessage("OpenROAD flow completed successfully!");
			} else {
				this.outputChannel.appendLine(`❌ OpenROAD flow failed with exit code: ${code}`);
				vscode.window.showErrorMessage(`OpenROAD flow failed with exit code: ${code}`);
			}
			try {
				await vscode.commands.executeCommand("openroad.flowCompleted", { success: code === 0, log: this.outputBuffer });
			} catch { }
			this.process = undefined;
			this.outputBuffer = "";
		});

		this.process.on("error", (error: Error) => {
			this.outputChannel.appendLine(`❌ Error: ${error.message}`);
			vscode.window.showErrorMessage(`OpenROAD flow error: ${error.message}`);
			this.process = undefined;
		});

		vscode.window.showInformationMessage("OpenROAD flow started. Check the output channel for progress.");
	}

	public async cleanAll(): Promise<void> {
		if (this.process) {
			vscode.window.showWarningMessage("OpenROAD flow is running. Stop it before cleaning.");
			return;
		}
		const cfg = vscode.workspace.getConfiguration();
		const flowHome = cfg.get<string>("openroad.flow.flowHome", "");
		const designConfig = cfg.get<string>("openroad.flow.designConfig", "");
		if (!flowHome || !designConfig) {
			vscode.window.showErrorMessage("OpenROAD flow not configured. Run 'OpenROAD: Configure Flow' first.");
			return;
		}
		const args = ["-C", flowHome, "clean_all", `DESIGN_CONFIG=${designConfig}`];
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine(`Running: make ${args.join(" ")}`);
		this.outputChannel.appendLine("");
		this.process = spawn("make", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => this.outputChannel.append(data.toString()));
		}
		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => this.outputChannel.append(data.toString()));
		}
		this.process.on("close", (code: number | null) => {
			this.outputChannel.appendLine("");
			if (code === 0) {
				this.outputChannel.appendLine("🧹 Cleaned all flow artifacts.");
				vscode.window.showInformationMessage("OpenROAD: clean_all completed.");
			} else {
				this.outputChannel.appendLine(`❌ clean_all failed with exit code: ${code}`);
				vscode.window.showErrorMessage(`OpenROAD: clean_all failed with exit code: ${code}`);
			}
			this.process = undefined;
		});
		this.process.on("error", (error: Error) => {
			this.outputChannel.appendLine(`❌ Error: ${error.message}`);
			vscode.window.showErrorMessage(`OpenROAD clean_all error: ${error.message}`);
			this.process = undefined;
		});
	}

	public async guiFinal(): Promise<void> {
		if (this.process) {
			vscode.window.showWarningMessage("OpenROAD flow is running. Stop it before launching GUI.");
			return;
		}
		const cfg = vscode.workspace.getConfiguration();
		const flowHome = cfg.get<string>("openroad.flow.flowHome", "");
		const designConfig = cfg.get<string>("openroad.flow.designConfig", "");
		if (!flowHome || !designConfig) {
			vscode.window.showErrorMessage("OpenROAD flow not configured. Run 'OpenROAD: Configure Flow' first.");
			return;
		}
		// We'll spawn a shell to source env.sh then run make gui_final
		const shellCmd = `set -e; cd "${flowHome}"; if [ -f ./env.sh ]; then . ./env.sh; fi; make gui_final DESIGN_CONFIG="${designConfig}"`;
		this.outputChannel.clear();
		this.outputChannel.show();
		this.outputChannel.appendLine("Launching OpenROAD GUI (gui_final)...\n");
		this.process = spawn(process.env.SHELL || "/bin/bash", ["-lc", shellCmd], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => this.outputChannel.append(data.toString()));
		}
		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => this.outputChannel.append(data.toString()));
		}
		this.process.on("close", (code: number | null) => {
			this.outputChannel.appendLine("\nOpenROAD GUI session ended.");
			if (code !== 0) {
				vscode.window.showErrorMessage(`OpenROAD GUI exited with code ${code}`);
			}
			this.process = undefined;
		});
		this.process.on("error", (error: Error) => {
			this.outputChannel.appendLine(`❌ Error: ${error.message}`);
			vscode.window.showErrorMessage(`OpenROAD GUI error: ${error.message}`);
			this.process = undefined;
		});
	}

	public stopFlow(): void {
		if (this.process) {
			this.process.kill("SIGTERM");
			this.outputChannel.appendLine("🛑 OpenROAD flow stopped by user.");
			vscode.window.showInformationMessage("OpenROAD flow stopped.");
			this.process = undefined;
		} else {
			vscode.window.showInformationMessage("No OpenROAD flow is currently running.");
		}
	}

	public isRunning(): boolean {
		return this.process !== undefined;
	}

	public dispose(): void {
		this.stopFlow();
		this.outputChannel.dispose();
		while (this.disposables.length) {
			const d = this.disposables.pop();
			try { d?.dispose(); } catch { }
		}
		OpenroadRunner.current = undefined;
	}
}
