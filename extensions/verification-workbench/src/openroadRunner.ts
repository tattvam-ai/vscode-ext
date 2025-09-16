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
				this.outputChannel.append(data.toString());
			});
		}

		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => {
				this.outputChannel.append(data.toString());
			});
		}

		this.process.on("close", (code: number | null) => {
			this.outputChannel.appendLine("");
			if (code === 0) {
				this.outputChannel.appendLine("✅ OpenROAD flow completed successfully!");
				vscode.window.showInformationMessage("OpenROAD flow completed successfully!");
			} else {
				this.outputChannel.appendLine(`❌ OpenROAD flow failed with exit code: ${code}`);
				vscode.window.showErrorMessage(`OpenROAD flow failed with exit code: ${code}`);
			}
			this.process = undefined;
		});

		this.process.on("error", (error: Error) => {
			this.outputChannel.appendLine(`❌ Error: ${error.message}`);
			vscode.window.showErrorMessage(`OpenROAD flow error: ${error.message}`);
			this.process = undefined;
		});

		vscode.window.showInformationMessage("OpenROAD flow started. Check the output channel for progress.");
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
