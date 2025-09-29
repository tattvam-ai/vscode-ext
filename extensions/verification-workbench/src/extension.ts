/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// +----------------+      User Input       +----------------+
// |                |  ----------------->  |                |
// |  VSCode Editor |                       |  Webview Panel |
// |  (extension.js)|  <-----------------  |  (chat UI)     |
// +----------------+      AI Response     +----------------+
//         ^                                     |
//         |                                     |
//         |                                     v
//         |                             +----------------+
//         |                             |                |
//         |                             |  Extension     |
//         |                             |  _handleChat   |
//         |                             |  _postMessage  |
//         |                             +----------------+
//         |                                     |
//         |                                     v
//         |                             +----------------+
//         |                             |                |
//         |                             |  OpenAI API    |
//         |                             |  (o3-mini)     |
//         |                             +----------------+
//         |
//         +-----------------------------------------+
//                    Commands: set/clear API key


import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { fetch } from "undici";
import { OpenroadConfigPanel } from "./openroadConfigPanel";
import { OpenroadRunner } from "./openroadRunner";
import { OpenroadSidebar } from "./openroadSidebar";
import { CocotbRunner } from "./cocotbRunner";
import { CocotbSidebar } from "./cocotbSidebar";
import { VerilatorRunner } from "./verilatorRunner";
import { VerilatorSidebar } from "./verilatorSidebar";
// import { OpenroadResultsSidebar } from "./openroadResultsSidebar";

// Simple Chip Assistant Provider
class AITerminalProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "aiTerminalView";
	private _view?: vscode.WebviewView;

	// Emit assistant responses so other commands can react (e.g., auto-save files)
	private static _assistantEmitter = new vscode.EventEmitter<string>();
	public static readonly onAssistantMessage: vscode.Event<string> = AITerminalProvider._assistantEmitter.event;
	private static _lastAssistantText: string | undefined;

	// Track pending regeneration requests
	private _pendingRegeneration?: { prompt: string; attempt: number };

	constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getChatHtml();

		// Handle messages from webview
		webviewView.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case "chat:send": {
						const text: string = message.text ?? "";
						await this._handleChatMessage(text);
						break;
					}
					case "chat:getConfig": {
						const config = vscode.workspace.getConfiguration();
						const useAdvanced = config.get<boolean>("chipAssistant.openai.useAdvancedModel", false);
						const baseModel = config.get<string>("chipAssistant.openai.model", "o3-mini");
						const advancedModel = config.get<string>("chipAssistant.openai.advancedModel", "gpt-4o");
						const model = useAdvanced ? advancedModel : baseModel;
						const baseUrl = config.get<string>("chipAssistant.openai.baseUrl", "https://api.openai.com/v1");
						const apiKey = await this._context.secrets.get("chipAssistant.openai.apiKey");
						this._postMessage({ command: "chat:config", payload: { hasKey: Boolean(apiKey), model, baseUrl, useAdvanced, baseModel, advancedModel } });
						break;
					}
					case "chat:setModel": {
						const config = vscode.workspace.getConfiguration();
						const { model, useAdvanced } = message.payload;

						if (useAdvanced) {
							await config.update("chipAssistant.openai.advancedModel", model, vscode.ConfigurationTarget.Workspace);
							await config.update("chipAssistant.openai.useAdvancedModel", true, vscode.ConfigurationTarget.Workspace);
						} else {
							await config.update("chipAssistant.openai.model", model, vscode.ConfigurationTarget.Workspace);
							await config.update("chipAssistant.openai.useAdvancedModel", false, vscode.ConfigurationTarget.Workspace);
						}

						vscode.window.showInformationMessage(`Chip Assistant: Switched to ${model}`);
						break;
					}
					case "chat:toggleAdvanced": {
						const config = vscode.workspace.getConfiguration();
						const { useAdvanced } = message.payload;
						await config.update("chipAssistant.openai.useAdvancedModel", useAdvanced, vscode.ConfigurationTarget.Workspace);

						const currentModel = config.get<string>(useAdvanced ? "chipAssistant.openai.advancedModel" : "chipAssistant.openai.model", "o3-mini");
						vscode.window.showInformationMessage(`Chip Assistant: ${useAdvanced ? 'Enabled' : 'Disabled'} Advanced Mode (${currentModel})`);
						break;
					}
					case "chat:regeneration": {
						const { action } = message.payload;
						await this._handleRegenerationResponse(action);
						break;
					}
				}
			},
			undefined,
			[],
		);
	}

	public async _handleChatMessage(userText: string) {
		if (!userText.trim()) {
			return;
		}
		this._postMessage({ command: "chat:userEcho", payload: { text: userText } });
		this._postMessage({ command: "chat:typing", payload: { on: true } });

		// Quick intent: run OpenROAD PD flow if user asks for it
		try {
			const lower = userText.toLowerCase();
			const wantsPdFlow = /(run|start|launch)\s+(pd\s*flow|physical\s*design|openroad(\s*flow)?)/.test(lower)
				|| lower.includes("run pd flow")
				|| lower.includes("run physical design")
				|| lower.includes("run openroad")
				|| lower.includes("start pd flow")
				|| lower.includes("start openroad");
			if (wantsPdFlow) {
				await vscode.commands.executeCommand("openroad.runFlow");
				this._postMessage({ command: "chat:assistant", payload: { text: "Starting OpenROAD PD flow with your configured settings..." } });
				return;
			}
		} catch { }

		let progressInterval: NodeJS.Timeout | undefined;
		try {
			const config = vscode.workspace.getConfiguration();
			const useAdvanced = config.get<boolean>("chipAssistant.openai.useAdvancedModel", false);
			const baseModel = config.get<string>("chipAssistant.openai.model", "o3-mini");
			const advancedModel = config.get<string>("chipAssistant.openai.advancedModel", "gpt-4o");
			const model = useAdvanced ? advancedModel : baseModel;
			const baseUrl = config.get<string>("chipAssistant.openai.baseUrl", "https://api.openai.com/v1");

			// Dynamic timeout based on model type - advanced models get more time
			const baseTimeoutMs = config.get<number>("chipAssistant.request.timeoutMs", 180000);
			const timeoutMs = useAdvanced ? Math.max(baseTimeoutMs, 300000) : baseTimeoutMs; // 5 minutes for advanced models

			const apiKey = await this._context.secrets.get("chipAssistant.openai.apiKey");

			if (!apiKey) {
				this._postMessage({ command: "chat:error", payload: { message: "OpenAI API key not set. Run 'Chip Assistant: Set OpenAI API Key'." } });
				return;
			}

			// Show timeout info for advanced models
			if (useAdvanced) {
				this._postMessage({
					command: "chat:typing",
					payload: {
						on: true,
						message: `ℹ️ Using advanced model (${model}) with ${Math.round(timeoutMs / 1000)}s timeout for complex requests...`
					}
				});
			}

			const controller = new AbortController();
			const t = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

			// Simple progress feedback for longer requests
			console.log("TimeoutMs:", timeoutMs);
			if (timeoutMs > 10000) { // Show "Still Thinking" for requests > 10 seconds (for testing)
				console.log("Setting up Still Thinking timeout...");
				progressInterval = setTimeout(() => {
					console.log("Sending Still Thinking message...");
					this._postMessage({
						command: "chat:typing",
						payload: {
							on: true,
							message: "Still Thinking..."
						}
					});
				}, 10000); // Update after 10 seconds (for testing)
			}

			let assistantText: string | undefined;
			try {
				// Build request body with conditional temperature
				const requestBody: any = {
					model,
					messages: [
						{ role: "user", content: userText },
					],
				};

				// Only add temperature for models that support it (not GPT-5 mini)
				if (!model.includes('gpt-5')) {
					requestBody.temperature = 0.2;
				}

				const resp = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(requestBody),
					signal: controller.signal,
				});
				if (resp.ok) {
					const data: any = await resp.json();
					assistantText = data?.choices?.[0]?.message?.content ?? "";
				} else {
					console.log("Primary API call failed with status:", resp.status);
					const errorText = await resp.text();
					console.log("Error response:", errorText);
				}
			} catch (err: any) {
				console.log("Primary API call failed:", err.message);
				if (err.name === 'AbortError') {
					console.log("Request was aborted due to timeout");
				}
				// fallback
			} finally {
				clearTimeout(t);
				if (progressInterval) clearTimeout(progressInterval);
			}

			if (!assistantText) {
				const controller2 = new AbortController();
				const t2 = setTimeout(() => controller2.abort(), Math.max(1000, timeoutMs));
				try {
					// Build fallback request body with conditional temperature
					const fallbackModel = model === "o3-mini" ? "gpt-4o-mini" : model;
					const fallbackBody: any = {
						model: fallbackModel,
						messages: [
							{ role: "user", content: userText },
						],
					};

					// Only add temperature for models that support it (not GPT-5 mini)
					if (!fallbackModel.includes('gpt-5')) {
						fallbackBody.temperature = 0.2;
					}

					const resp2 = await fetch(`${baseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"Authorization": `Bearer ${apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(fallbackBody),
						signal: controller2.signal,
					});
					if (!resp2.ok) {
						const errText = await resp2.text();
						throw new Error(`OpenAI error ${resp2.status}: ${errText}`);
					}
					const data2: any = await resp2.json();
					assistantText = data2?.choices?.[0]?.message?.content ?? "";
				} catch (err: any) {
					console.log("Fallback API call failed:", err.message);
					if (err.name === 'AbortError') {
						this._postMessage({ command: "chat:error", payload: { message: "Request timed out. The model is taking too long to respond. Please try again with a shorter request." } });
					} else {
						this._postMessage({ command: "chat:error", payload: { message: `Error: ${err.message}` } });
					}
				} finally {
					clearTimeout(t2);
					if (progressInterval) clearTimeout(progressInterval);
				}
			}

			this._postMessage({ command: "chat:assistant", payload: { text: assistantText ?? "" } });
			if (assistantText !== undefined) {
				AITerminalProvider._lastAssistantText = assistantText;
				AITerminalProvider._assistantEmitter.fire(assistantText);

				// Check if this is a testbench generation request and extract Python code
				if (userText.includes("Generate a clean, production-ready Python Cocotb") || userText.includes("testbench") || userText.includes("cocotb")) {
					await this._extractAndSaveTestbench(assistantText, userText);
				}
			}
		} catch (err: any) {
			let message = err?.message ?? String(err);
			if (err.name === 'AbortError') {
				message = "Request timed out. The model is taking too long to respond. Please try again with a shorter request.";
			}
			this._postMessage({ command: "chat:error", payload: { message } });
		}
		finally {
			this._postMessage({ command: "chat:typing", payload: { on: false } });
			if (progressInterval) clearTimeout(progressInterval);
		}
	}

	private _postMessage(msg: any) {
		if (this._view) {
			this._view.webview.postMessage(msg);
		}
	}

	private async _extractAndSaveTestbench(responseText: string, originalPrompt?: string) {
		try {
			// Extract Python code from the response
			const pythonCode = this._extractPythonCode(responseText);
			if (!pythonCode) {
				console.log("No Python code found in response");
				return;
			}

			// Get the test directory from cocotb configuration
			const config = vscode.workspace.getConfiguration();
			const testDir = config.get<string>("cocotb.testDirectory", "");

			if (!testDir) {
				this._postMessage({
					command: "chat:info",
					payload: {
						message: "⚠️ No test directory configured. Please set cocotb.testDirectory in settings or use the Cocotb sidebar to browse for a test directory."
					}
				});
				return;
			}

			// Create test.py file path
			const testFilePath = vscode.Uri.joinPath(vscode.Uri.file(testDir), "test.py");

			// Show testplan panel and start workflow
			this._postMessage({
				command: "testplan:show",
				payload: { show: true }
			});

			// Write the Python code to the file
			await vscode.workspace.fs.writeFile(testFilePath, Buffer.from(pythonCode, 'utf8'));
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "testbench_save",
					status: "success",
					detail: testFilePath.fsPath
				}
			});

			// Open the file in the editor
			await vscode.window.showTextDocument(testFilePath);

			// Check and update Makefile configuration
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "makefile_check",
					status: "in_progress",
					detail: "Checking COCOTB_TEST_MODULES..."
				}
			});
			const makefileUpdated = await this._checkAndUpdateMakefile(testDir);
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "makefile_check",
					status: makefileUpdated ? "success" : "warning",
					detail: makefileUpdated ? "COCOTB_TEST_MODULES = test" : "Makefile check failed"
				}
			});

			// Automatically run the cocotb tests (regardless of Makefile status)
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "test_execution",
					status: "in_progress",
					detail: "Running cocotb tests..."
				}
			});
			await this._runCocotbTests(testDir, originalPrompt || "", 0);

		} catch (error: any) {
			console.error("Error saving testbench:", error);
			this._postMessage({
				command: "chat:error",
				payload: {
					message: `Failed to save testbench: ${error.message}`
				}
			});
		}
	}

	private _extractPythonCode(text: string): string | null {
		// Look for Python code blocks in markdown format
		const pythonCodeRegex = /```(?:python|py)?\n([\s\S]*?)```/;
		const match = text.match(pythonCodeRegex);

		if (match && match[1]) {
			return match[1].trim();
		}

		// If no markdown code block, look for Python-like content
		// This is a fallback for responses that don't use proper markdown
		const lines = text.split('\n');
		const pythonLines: string[] = [];
		let inPythonBlock = false;

		for (const line of lines) {
			// Check if line looks like Python code
			if (line.includes('import ') || line.includes('from ') || line.includes('def ') || line.includes('class ') || line.includes('@cocotb')) {
				inPythonBlock = true;
			}

			if (inPythonBlock) {
				pythonLines.push(line);

				// Stop if we hit a non-Python line that's not indented
				if (line.trim() && !line.startsWith(' ') && !line.startsWith('\t') && !line.includes('import ') && !line.includes('from ') && !line.includes('def ') && !line.includes('class ') && !line.includes('@cocotb') && !line.includes('#')) {
					break;
				}
			}
		}

		if (pythonLines.length > 0) {
			return pythonLines.join('\n').trim();
		}

		return null;
	}

	private async _checkAndUpdateMakefile(testDir: string): Promise<boolean> {
		try {
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "makefile_check",
					status: "in_progress",
					detail: `Checking Makefile in: ${testDir}`
				}
			});
			const makefilePath = vscode.Uri.joinPath(vscode.Uri.file(testDir), "Makefile");

			// Check if Makefile exists
			try {
				await vscode.workspace.fs.stat(makefilePath);
				this._postMessage({
					command: "testplan:updateStep",
					payload: {
						stepId: "makefile_check",
						status: "in_progress",
						detail: "Makefile found, proceeding with update..."
					}
				});
			} catch {
				this._postMessage({
					command: "testplan:updateStep",
					payload: {
						stepId: "makefile_check",
						status: "warning",
						detail: "No Makefile found, skipping update"
					}
				});
				return false;
			}

			// Read the Makefile
			const makefileContent = await vscode.workspace.fs.readFile(makefilePath);
			const makefileText = Buffer.from(makefileContent).toString('utf8');

			// Check if COCOTB_TEST_MODULES is set to "test"
			const testModulesRegex = /COCOTB_TEST_MODULES\s*=\s*(.+)/;
			const match = makefileText.match(testModulesRegex);

			if (match) {
				const currentValue = match[1].trim();
				if (currentValue === 'test') {
					this._postMessage({
						command: "testplan:updateStep",
						payload: {
							stepId: "makefile_check",
							status: "success",
							detail: "Makefile already configured: COCOTB_TEST_MODULES = test"
						}
					});
					return true;
				}

				// Update the value
				const updatedContent = makefileText.replace(testModulesRegex, 'COCOTB_TEST_MODULES = test');
				await vscode.workspace.fs.writeFile(makefilePath, Buffer.from(updatedContent, 'utf8'));

				this._postMessage({
					command: "testplan:updateStep",
					payload: {
						stepId: "makefile_check",
						status: "success",
						detail: `Updated Makefile: COCOTB_TEST_MODULES = test (was: ${currentValue})`
					}
				});
				return true;
			} else {
				// Add COCOTB_TEST_MODULES if it doesn't exist
				const updatedContent = makefileText + '\nCOCOTB_TEST_MODULES = test\n';
				await vscode.workspace.fs.writeFile(makefilePath, Buffer.from(updatedContent, 'utf8'));

				this._postMessage({
					command: "testplan:updateStep",
					payload: {
						stepId: "makefile_check",
						status: "success",
						detail: "Added to Makefile: COCOTB_TEST_MODULES = test"
					}
				});
				return true;
			}

		} catch (error: any) {
			console.error("Error updating Makefile:", error);
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "makefile_check",
					status: "error",
					detail: `Failed to update Makefile: ${error.message}`
				}
			});
			return false;
		}
	}

	private async _runCocotbTests(testDir: string, originalPrompt?: string, regenerationAttempt: number = 0) {
		try {
			// Wait a moment to ensure file is fully written
			await new Promise(resolve => setTimeout(resolve, 1000));

			// Execute the cocotb run command
			const result = await vscode.commands.executeCommand('cocotb.runTests');

			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "test_execution",
					status: "success",
					detail: "Cocotb tests execution initiated"
				}
			});

			// Assume failure for AI-generated testbenches (realistic scenario)
			// In production, this would be based on actual test results
			if (originalPrompt) {
				// Set up a timer to check for test completion and capture output
				setTimeout(async () => {
					await this._checkForTestFailureAndAnalyze(testDir, originalPrompt, regenerationAttempt);
				}, 8000); // Wait 8 seconds for tests to complete
			}

		} catch (error: any) {
			this._postMessage({
				command: "chat:error",
				payload: {
					message: `❌ Error running cocotb tests: ${error.message}`
				}
			});

		}
	}

	private async _offerTestbenchRegeneration(originalPrompt: string, regenerationAttempt: number) {
		// Show failure message and offer regeneration
		console.log("Offering testbench regeneration, attempt:", regenerationAttempt);
		this._postMessage({
			command: "chat:error",
			payload: {
				message: `❌ Tests failed (attempt ${regenerationAttempt}). Would you like me to regenerate the testbench?`
			}
		});

		// Add interactive buttons for user choice
		console.log("Sending buttons message with buttons:", [{ id: "regenerate_yes", text: "Yes", action: "regenerate" }, { id: "regenerate_no", text: "No", action: "stop" }]);
		this._postMessage({
			command: "chat:info",
			payload: {
				message: "🔄 Click 'Yes' to regenerate testbench or 'No' to stop",
				buttons: [
					{ id: "regenerate_yes", text: "Yes", action: "regenerate" },
					{ id: "regenerate_no", text: "No", action: "stop" }
				]
			}
		});

		// Store the regeneration context for when user responds
		this._pendingRegeneration = {
			prompt: originalPrompt,
			attempt: regenerationAttempt + 1
		};
		console.log("Stored pending regeneration:", this._pendingRegeneration);
	}

	private async _checkForTestFailureAndAnalyze(testDir: string, originalPrompt: string, regenerationAttempt: number) {
		try {
			// Capture test output from various sources
			const testOutput = await this._captureTestOutput(testDir);

			// Log the captured output for debugging
			console.log("Captured test output:", testOutput);

			// Check for success indicators first
			const hasSuccess = testOutput && (
				testOutput.includes('PASSED') ||
				testOutput.includes('PASS') ||
				testOutput.includes('SUCCESS') ||
				testOutput.includes('All tests passed') ||
				testOutput.includes('Test completed successfully') ||
				testOutput.includes('0 failures') ||
				testOutput.includes('simulation finished')
			);

			// Check for failure indicators
			const hasFailure = testOutput && (
				testOutput.includes('Error') ||
				testOutput.includes('FAILED') ||
				testOutput.includes('make: ***') ||
				testOutput.includes('FAIL') ||
				testOutput.includes('error') ||
				testOutput.includes('failed') ||
				testOutput.includes('Exception') ||
				testOutput.includes('Traceback')
			);

			if (hasSuccess && !hasFailure) {
				// Tests actually succeeded!
				this._postMessage({
					command: "testplan:updateStep",
					payload: {
						stepId: "test_execution",
						status: "success",
						detail: "Tests completed successfully!"
					}
				});
				this._postMessage({
					command: "chat:info",
					payload: {
						message: "🎉 Tests completed successfully! The AI-generated testbench is working correctly. ✅ No regeneration needed."
					}
				});
			} else if (hasFailure) {
				// Tests failed, analyze the failure
				this._postMessage({
					command: "testplan:updateStep",
					payload: {
						stepId: "failure_analysis",
						status: "in_progress",
						detail: "Analyzing test failure..."
					}
				});
				await this._analyzeFailureAndOfferRegeneration(testOutput, originalPrompt, regenerationAttempt);
			} else {
				// No clear success or failure indicators - check if this is first attempt
				if (regenerationAttempt === 0) {
					// First attempt with no clear indicators - assume failure for AI-generated testbench
					this._postMessage({
						command: "testplan:updateStep",
						payload: {
							stepId: "failure_analysis",
							status: "in_progress",
							detail: "No clear indicators found, assuming failure..."
						}
					});
					await this._analyzeFailureAndOfferRegeneration(testOutput || "No specific test output captured", originalPrompt, regenerationAttempt);
				} else {
					// Subsequent attempts - be more conservative
					this._postMessage({
						command: "testplan:updateStep",
						payload: {
							stepId: "failure_analysis",
							status: "warning",
							detail: `No clear indicators in attempt ${regenerationAttempt}`
						}
					});
					this._postMessage({
						command: "chat:info",
						payload: {
							message: "🔄 Would you like to try regenerating again or stop here?",
							buttons: [
								{ id: "regenerate_yes", text: "Try again", action: "regenerate" },
								{ id: "regenerate_no", text: "Stop here", action: "stop" }
							]
						}
					});

					// Store context for user choice
					this._pendingRegeneration = {
						prompt: originalPrompt,
						attempt: regenerationAttempt + 1
					};
				}
			}
		} catch (error: any) {
			console.error("Error checking test failure:", error);
			// Fallback to simple regeneration offer
			await this._offerTestbenchRegeneration(originalPrompt, regenerationAttempt);
		}
	}

	private async _captureTestOutput(testDir: string): Promise<string> {
		try {
			// Try to read from common cocotb output files
			const possibleOutputFiles = [
				'results.xml',
				'cocotb.log',
				'sim_build/sim.log',
				'sim_build/compile.log',
				'sim_build/simv.log',
				'sim_build/verilator.log',
				'Makefile.log'
			];

			let capturedOutput = "";
			let foundFiles = 0;

			for (const fileName of possibleOutputFiles) {
				try {
					const filePath = vscode.Uri.joinPath(vscode.Uri.file(testDir), fileName);
					const content = await vscode.workspace.fs.readFile(filePath);
					const text = Buffer.from(content).toString('utf8');
					if (text && text.length > 0) {
						capturedOutput += `\n=== ${fileName} ===\n${text}\n`;
						foundFiles++;
					}
				} catch {
					// File doesn't exist or can't be read, try next one
					continue;
				}
			}

			if (foundFiles > 0) {
				return capturedOutput;
			}

			// If no specific output files found, check if there are any files in the directory
			try {
				const dirContents = await vscode.workspace.fs.readDirectory(vscode.Uri.file(testDir));
				const logFiles = dirContents.filter(([name, type]) =>
					type === vscode.FileType.File &&
					(name.includes('.log') || name.includes('results') || name.includes('sim'))
				);

				if (logFiles.length > 0) {
					return `Found ${logFiles.length} potential log files but couldn't read them: ${logFiles.map(([name]) => name).join(', ')}`;
				}
			} catch {
				// Directory read failed
			}

			// Return a message indicating we should assume failure for AI-generated testbenches
			return "No test output files found. This is typical for AI-generated testbenches which often fail due to syntax errors, signal mismatches, or missing clock/reset logic.";
		} catch (error: any) {
			console.error("Error capturing test output:", error);
			return "Error capturing test output: " + error.message;
		}
	}

	private async _analyzeFailureAndOfferRegeneration(testOutput: string, originalPrompt: string, regenerationAttempt: number) {
		// Update testplan panel
		this._postMessage({
			command: "testplan:updateStep",
			payload: {
				stepId: "failure_analysis",
				status: "in_progress",
				detail: `Analyzing failure (attempt ${regenerationAttempt})...`
			}
		});

		// Create analysis prompt
		const analysisPrompt = `Can you identify the failure points from this cocotb test output and suggest specific fixes?

Test Output:
${testOutput}

Please analyze the errors and provide specific recommendations for fixing the testbench. Focus on:
1. Syntax errors
2. Signal connection issues
3. Clock/reset problems
4. Data type mismatches
5. Cocotb API usage issues

Provide a brief analysis of the main issues found.`;

		try {
			// Get AI analysis of the failure
			const analysisResponse = await this._getAIAnalysis(analysisPrompt);

			// Update testplan panel
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "failure_analysis",
					status: "success",
					detail: "Analysis completed"
				}
			});

			// Show the analysis to user
			this._postMessage({
				command: "chat:assistant",
				payload: {
					text: `**Failure Analysis:**\n\n${analysisResponse}`
				}
			});

			// Offer regeneration with improved prompt
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "regeneration",
					status: "pending",
					detail: "Waiting for user decision..."
				}
			});
			this._postMessage({
				command: "chat:info",
				payload: {
					message: "🔄 Based on the analysis above, would you like me to regenerate the testbench with fixes?",
					buttons: [
						{ id: "regenerate_yes", text: "Yes, regenerate with fixes", action: "regenerate" },
						{ id: "regenerate_no", text: "No, stop here", action: "stop" }
					]
				}
			});

			// Store enhanced regeneration context
			this._pendingRegeneration = {
				prompt: `${originalPrompt}\n\nPrevious attempt failed. Please fix these issues:\n${analysisResponse}`,
				attempt: regenerationAttempt + 1
			};

		} catch (error: any) {
			console.error("Error getting AI analysis:", error);
			// Fallback to simple regeneration offer
			await this._offerTestbenchRegeneration(originalPrompt, regenerationAttempt);
		}
	}

	private async _getAIAnalysis(prompt: string): Promise<string> {
		try {
			// Use the same AI service as the main chat
			const config = vscode.workspace.getConfiguration();
			const apiKey = await this._context.secrets.get("chipAssistant.openai.apiKey");

			if (!apiKey) {
				return "API key not configured. Providing generic analysis: AI-generated testbenches commonly fail due to syntax errors, missing clock/reset logic, signal width mismatches, or incorrect Cocotb API usage.";
			}

			const useAdvanced = config.get<boolean>("chipAssistant.openai.useAdvancedModel", false);
			const baseModel = config.get<string>("chipAssistant.openai.model", "o3-mini");
			const advancedModel = config.get<string>("chipAssistant.openai.advancedModel", "gpt-4o");
			const model = useAdvanced ? advancedModel : baseModel;

			const response = await fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: model,
					messages: [
						{
							role: "system",
							content: "You are an expert in Cocotb testbench debugging. Analyze test failures and provide specific, actionable recommendations for fixing Python testbenches. Keep responses concise and focused on technical issues."
						},
						{
							role: "user",
							content: prompt
						}
					],
					temperature: model.includes('gpt-5') ? undefined : 0.2,
					max_tokens: 800
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error("OpenAI API error:", response.status, errorText);
				return this._getGenericFailureAnalysis();
			}

			const data = await response.json() as any;
			const analysis = data.choices?.[0]?.message?.content || this._getGenericFailureAnalysis();

			return analysis;
		} catch (error: any) {
			console.error("Error getting AI analysis:", error);
			return this._getGenericFailureAnalysis();
		}
	}

	private _getGenericFailureAnalysis(): string {
		return `**Common AI-Generated Testbench Issues:**

1. **Clock Generation**: Missing or incorrect clock signal generation
2. **Reset Logic**: Improper reset sequence or missing reset handling
3. **Signal Widths**: Mismatched signal widths between testbench and DUT
4. **Signal Connections**: Incorrect port connections or missing signals
5. **Python Syntax**: Missing colons, incorrect indentation, or typos
6. **Cocotb API**: Using deprecated APIs or incorrect function calls
7. **Data Types**: Wrong data types for signals or test values
8. **Timing Issues**: Missing delays or incorrect timing relationships

The regenerated testbench will address these common issues with proper clock generation, reset handling, and modern Cocotb v2.0+ APIs.`;
	}

	private async _handleRegenerationResponse(action: string) {
		if (!this._pendingRegeneration) return;

		const { prompt, attempt } = this._pendingRegeneration;
		this._pendingRegeneration = undefined;

		if (action === "regenerate") {
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "regeneration",
					status: "in_progress",
					detail: `Regenerating testbench (attempt ${attempt})...`
				}
			});

			// Regenerate the testbench
			await this._handleChatMessage(prompt);
		} else {
			this._postMessage({
				command: "testplan:updateStep",
				payload: {
					stepId: "regeneration",
					status: "error",
					detail: "User stopped regeneration"
				}
			});
			this._postMessage({
				command: "chat:info",
				payload: {
					message: "⏹️ Stopping regeneration process. You can manually edit the testbench if needed."
				}
			});
		}
	}

	public async askWithIntent(intentLabel: string, selectedText: string) {
		const prompt = `${intentLabel}:\n\n${selectedText}`;
		await vscode.commands.executeCommand("aiTerminalView.focus");
		await this._handleChatMessage(prompt);
	}

	private static _extractTextFromResponses(obj: any): string {
		try {
			const output = obj?.output ?? obj?.response ?? obj;
			const first = Array.isArray(output)?.valueOf() ? output[0] : (output?.[0] ?? output);
			const content = first?.content ?? obj?.content ?? [];
			const parts = Array.isArray(content) ? content : [];
			const text = parts.map((p: any) => p?.text ?? p?.content ?? "").filter(Boolean).join("\n");
			return text || JSON.stringify(obj);
		} catch {
			return "";
		}
	}

	private _getChatHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Chip Assistant</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			padding: 0;
			margin: 0;
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			height: 100vh;
			display: flex;
			flex-direction: column;
		}
		.header { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
		.chat-container { flex: 1; overflow-y: auto; padding: 12px; font-size: 13px; line-height: 1.4; }
		.msg { margin: 8px 0; display: flex; }
		.msg .bubble { max-width: 85%; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
		.msg.user { justify-content: flex-end; }
		.msg.user .bubble { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); }
		.msg.assistant .bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
		/* basic markdown styling */
		.msg.assistant .bubble h1, .msg.assistant .bubble h2, .msg.assistant .bubble h3 { margin: 6px 0 4px; font-weight: 600; }
		.msg.assistant .bubble ul { padding-left: 16px; margin: 4px 0; }
		.msg.assistant .bubble li { margin: 2px 0; }
		.msg.assistant .bubble code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 0 3px; border-radius: 3px; }
		.msg.assistant .bubble pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 8px; border-radius: 6px; overflow-x: auto; }
		.footer { display: flex; flex-direction: column; gap: 8px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
		.model-controls { display: flex; gap: 12px; align-items: center; margin-bottom: 4px; }
		.model-controls select { padding: 4px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-size: 12px; }
		.advanced-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-foreground); cursor: pointer; }
		.advanced-toggle input[type="checkbox"] { margin: 0; }
		.footer-row { display: flex; gap: 8px; }
		textarea { flex: 1; resize: none; max-height: 120px; min-height: 38px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 8px; font-family: var(--vscode-font-family); }
		button { padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; cursor: pointer; }
		.button-container { margin-top: 8px; }
		.interactive-button { margin-right: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border); padding: 6px 12px; border-radius: 4px; cursor: pointer; }
		.interactive-button:hover { background: var(--vscode-button-hoverBackground); }
		.testplan-panel { background: var(--vscode-panel-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 8px 12px; padding: 8px; display: none; font-size: 12px; }
		.testplan-panel.show { display: block; }
		.testplan-title { font-weight: 600; margin-bottom: 6px; color: var(--vscode-foreground); }
		.testplan-step { display: flex; align-items: center; margin-bottom: 3px; padding: 2px 0; }
		.testplan-step-icon { margin-right: 6px; width: 14px; text-align: center; font-size: 11px; }
		.testplan-step-text { flex: 1; color: var(--vscode-foreground); }
		.testplan-step-detail { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 20px; margin-top: 1px; }
	</style>
</head>
<body>
	<div class="header">Chip Assistant</div>
	<div class="testplan-panel" id="testplanPanel">
		<div class="testplan-title">📋 Automated Testbench Workflow</div>
		<div id="testplanSteps"></div>
	</div>
	<div class="chat-container" id="chatContainer"></div>
	<div class="footer">
		<div class="model-controls">
			<select id="modelSelect">
				<option value="o3-mini">o3-mini (Standard)</option>
				<option value="gpt-4o-mini">gpt-4o-mini (Standard)</option>
				<option value="gpt-5-mini">gpt-5-mini (Standard)</option>
				<option value="gpt-4o">gpt-4o (Advanced)</option>
				<option value="gpt-4-turbo">gpt-4-turbo (Advanced)</option>
				<option value="gpt-4">gpt-4 (Advanced)</option>
				<option value="o1-preview">o1-preview (Advanced)</option>
				<option value="o1-mini">o1-mini (Advanced)</option>
			</select>
			<label class="advanced-toggle">
				<input type="checkbox" id="advancedModeToggle">
				<span>Advanced Mode</span>
			</label>
		</div>
		<div class="footer-row">
			<textarea id="promptInput" placeholder="Ask about RTL, testbenches, SystemVerilog..."></textarea>
			<button id="sendBtn">Send</button>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		function addMessage(role, text) {
			const container = document.getElementById('chatContainer');
			const row = document.createElement('div');
			row.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
			const bubble = document.createElement('div');
			bubble.className = 'bubble';
			bubble.textContent = String(text || '');
			row.appendChild(bubble);
			container.appendChild(row);
			container.scrollTop = container.scrollHeight;
		}

		let typingEl = null;
		function setTyping(on, message = 'Thinking…') {
			console.log('setTyping called:', on, message);
			const container = document.getElementById('chatContainer');
			if (on) {
				if (typingEl) {
					// Update existing thinking message
					console.log('Updating existing typing message to:', message);
					const bubble = typingEl.querySelector('.bubble');
					if (bubble) bubble.textContent = message;
					return;
				}
				console.log('Creating new typing message:', message);
				typingEl = document.createElement('div');
				typingEl.className = 'msg assistant';
				const b = document.createElement('div');
				b.className = 'bubble';
				b.textContent = message;
				typingEl.appendChild(b);
				container.appendChild(typingEl);
				container.scrollTop = container.scrollHeight;
			} else if (typingEl) {
				console.log('Removing typing message');
				typingEl.remove();
				typingEl = null;
			}
		}

		function addInteractiveButtons(buttons) {
			console.log('addInteractiveButtons called with:', buttons);
			const container = document.getElementById('chatContainer');
			console.log('Found chatContainer:', container);
			const buttonContainer = document.createElement('div');
			buttonContainer.className = 'msg assistant button-container';
			console.log('Created buttonContainer:', buttonContainer);

			buttons.forEach(button => {
				console.log('Creating button:', button);
				const btn = document.createElement('button');
				btn.textContent = button.text;
				btn.className = 'interactive-button';
				btn.onclick = () => {
					console.log('Button clicked:', button.action);
					// Send button action to backend
					vscode.postMessage({
						command: 'chat:regeneration',
						payload: { action: button.action }
					});
					// Remove buttons after click
					buttonContainer.remove();
				};
				buttonContainer.appendChild(btn);
				console.log('Button added to container');
			});

			container.appendChild(buttonContainer);
			container.scrollTop = container.scrollHeight;
			console.log('Button container added to chat, total buttons:', buttonContainer.children.length);
		}

		function showTestplan(show) {
			const panel = document.getElementById('testplanPanel');
			if (show) {
				panel.classList.add('show');
			} else {
				panel.classList.remove('show');
			}
		}

		function updateTestplanStep(stepId, status, detail = '') {
			const stepsContainer = document.getElementById('testplanSteps');
			let stepElement = document.getElementById('step-' + stepId);

			if (!stepElement) {
				stepElement = document.createElement('div');
				stepElement.className = 'testplan-step';
				stepElement.id = 'step-' + stepId;
				stepsContainer.appendChild(stepElement);
			}

			const icons = {
				'pending': '⏳',
				'in_progress': '🔄',
				'success': '✅',
				'error': '❌',
				'warning': '⚠️'
			};

			const stepTexts = {
				'testbench_save': 'Testbench saved',
				'makefile_check': 'Makefile check',
				'test_execution': 'Test execution',
				'failure_analysis': 'Failure analysis',
				'regeneration': 'Testbench regeneration'
			};

			stepElement.innerHTML =
				'<div class="testplan-step-icon">' + (icons[status] || '⏳') + '</div>' +
				'<div class="testplan-step-text">' + (stepTexts[stepId] || stepId) + '</div>' +
				(detail ? '<div class="testplan-step-detail">' + detail + '</div>' : '');
		}

		function sendPrompt() {
			const input = document.getElementById('promptInput');
			const text = input.value.trim();
			if (!text) return;
			vscode.postMessage({ command: 'chat:send', text });
			input.value = '';
		}

		// Handle messages from extension
		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.command) {
				case 'chat:assistant': {
					addMessage('assistant', message.payload?.text || '');
					break;
				}
			case 'chat:error': {
				addMessage('assistant', 'Error: ' + (message.payload?.message || 'Unknown error'));
				break;
			}
			case 'chat:info': {
				console.log('Received chat:info message:', message.payload);
				addMessage('assistant', message.payload?.message || '');
				// Handle interactive buttons if present
				if (message.payload?.buttons) {
					console.log('Buttons found in message, calling addInteractiveButtons:', message.payload.buttons);
					addInteractiveButtons(message.payload.buttons);
				} else {
					console.log('No buttons found in message');
				}
				break;
			}
			case 'chat:typing': {
				console.log('Received chat:typing message:', message.payload);
				setTyping(Boolean(message.payload?.on), message.payload?.message || 'Thinking…');
				break;
			}
			case 'chat:config': {
				// Update UI with current configuration
				const config = message.payload;
				if (config) {
					const modelSelect = document.getElementById('modelSelect');
					const advancedToggle = document.getElementById('advancedModeToggle');

					// Set the model dropdown
					if (modelSelect && config.model) {
						modelSelect.value = config.model;
					}

					// Set the advanced mode toggle
					if (advancedToggle && config.useAdvanced !== undefined) {
						advancedToggle.checked = config.useAdvanced;
					}
				}
				break;
			}
			case 'testplan:show': {
				showTestplan(message.payload.show);
				break;
			}
			case 'testplan:updateStep': {
				updateTestplanStep(message.payload.stepId, message.payload.status, message.payload.detail);
				break;
			}
			case 'chat:setModel': {
				// Model selection handled by backend
				break;
			}
			case 'chat:toggleAdvanced': {
				// Advanced mode toggle handled by backend
				break;
			}
				case 'chat:userEcho': {
					addMessage('user', message.payload?.text || '');
					break;
				}
			}
		});

		document.getElementById('sendBtn').addEventListener('click', sendPrompt);
		document.getElementById('promptInput').addEventListener('keypress', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendPrompt();
			}
		});

		// Model selection controls
		document.getElementById('modelSelect').addEventListener('change', function (e) {
			const selectedModel = e.target.value;
			const isAdvanced = ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-5-mini', 'o1-preview', 'o1-mini'].includes(selectedModel);
			vscode.postMessage({
				command: 'chat:setModel',
				payload: {
					model: selectedModel,
					useAdvanced: isAdvanced
				}
			});
		});

		document.getElementById('advancedModeToggle').addEventListener('change', function (e) {
			const useAdvanced = e.target.checked;
			vscode.postMessage({
				command: 'chat:toggleAdvanced',
				payload: { useAdvanced }
			});
		});

		vscode.postMessage({ command: 'chat:getConfig' });
	</script>
	</body>
	</html>`;
	}
}

class SelectionIntentCodeLensProvider implements vscode.CodeLensProvider {
	private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

	private _activeSelection: { documentUri: string; range: vscode.Range } | null = null;

	public setActiveSelection(document: vscode.TextDocument, range: vscode.Range) {
		this._activeSelection = { documentUri: document.uri.toString(), range };
		this._onDidChangeCodeLenses.fire();
	}

	public clear() {
		this._activeSelection = null;
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
		if (!this._activeSelection || this._activeSelection.documentUri !== document.uri.toString()) {
			return [];
		}
		const line = this._activeSelection.range.start.line;
		const pos = new vscode.Position(Math.max(0, line), 0);
		const range = new vscode.Range(pos, pos);

		const items: { title: string; command: string }[] = [
			{ title: "Explain", command: "chipAssistant.explainSelection" },
			{ title: "Find Bugs", command: "chipAssistant.findBugsSelection" },
			{ title: "SV Assertions", command: "chipAssistant.assertionsSelection" },
			{ title: "Optimize", command: "chipAssistant.optimizeSelection" },
			{ title: "Generate TB", command: "chipAssistant.cocotbTestSelection" },
		];

		return items.map(it => new vscode.CodeLens(range, { title: it.title, command: it.command }));
	}
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
	console.log("Chip Assistant extension is now active!");

	// Register the Chip Assistant provider
	const aiTerminalProvider = new AITerminalProvider(context.extensionUri, context);

	// OpenROAD status bar item (Run/Stop)
	const openroadStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	openroadStatusItem.name = "OpenROAD Flow";
	context.subscriptions.push(openroadStatusItem);

	// OpenROAD actions status bar item (ellipsis opens actions)
	const openroadActionsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	openroadActionsItem.name = "OpenROAD Actions";
	openroadActionsItem.text = "$(kebab-vertical)";
	openroadActionsItem.tooltip = "OpenROAD actions (Run/Stop, Clean All, Configure)";
	openroadActionsItem.command = "openroad.actions";
	openroadActionsItem.show();
	context.subscriptions.push(openroadActionsItem);

	function updateOpenroadStatusItem() {
		const running = OpenroadRunner.getInstance().isRunning();
		openroadStatusItem.text = running ? "$(debug-stop) OpenROAD Stop" : "$(play) OpenROAD Run";
		openroadStatusItem.command = running ? "openroad.stopFlow" : "openroad.runFlow";
		openroadStatusItem.tooltip = running ? "Stop OpenROAD flow (Right-click for actions)" : "Run OpenROAD flow (Right-click for actions)";
		openroadStatusItem.show();
	}
	updateOpenroadStatusItem();
	const statusTimer = setInterval(updateOpenroadStatusItem, 1000);
	context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

	// OpenROAD: Show GUI (gui_final)
	const guiFinal = vscode.commands.registerCommand("openroad.guiFinal", async () => {
		const runner = OpenroadRunner.getInstance();
		await runner.guiFinal();
		updateOpenroadStatusItem();
	});

	const openroadActions = vscode.commands.registerCommand("openroad.actions", async () => {
		const running = OpenroadRunner.getInstance().isRunning();
		const picks: Array<{ label: string; action: () => Promise<void> | void }> = [
			{ label: running ? "Stop Flow" : "Run Flow", action: async () => running ? vscode.commands.executeCommand("openroad.stopFlow") : vscode.commands.executeCommand("openroad.runFlow") },
			{ label: "Clean All", action: async () => vscode.commands.executeCommand("openroad.cleanAll") },
			{ label: "Show GUI (gui_final)", action: async () => vscode.commands.executeCommand("openroad.guiFinal") },
			{ label: "Configure Flow", action: async () => vscode.commands.executeCommand("openroad.configureFlow") },
		];
		const choice = await vscode.window.showQuickPick(picks.map(p => p.label), { placeHolder: "OpenROAD actions" });
		const picked = picks.find(p => p.label === choice);
		if (picked) {
			await picked.action();
			updateOpenroadStatusItem();
		}
	});
	context.subscriptions.push(openroadActions);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			AITerminalProvider.viewType,
			aiTerminalProvider,
		),
	);

	const openroadSidebarProvider = new OpenroadSidebar(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			OpenroadSidebar.viewType,
			openroadSidebarProvider,
		),
	);

	const cocotbSidebarProvider = new CocotbSidebar(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			CocotbSidebar.viewType,
			cocotbSidebarProvider,
		),
	);

	// Verilator sidebar
	const verilatorSidebarProvider = VerilatorSidebar.getInstance();
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			VerilatorSidebar.viewType,
			verilatorSidebarProvider,
		),
	);

	// Results sidebar removed
	// const resultsSidebarProvider = new OpenroadResultsSidebar(context.extensionUri);
	// context.subscriptions.push(
	// 	vscode.window.registerWebviewViewProvider(
	// 		OpenroadResultsSidebar.viewType,
	// 		resultsSidebarProvider,
	// 	),
	// );

	// Simple command to show the Chip Assistant
	const showAITerminal = vscode.commands.registerCommand(
		"aiTerminal.show",
		() => {
			vscode.commands.executeCommand("aiTerminalView.focus");
			vscode.window.showInformationMessage("Chip Assistant activated!");
		},
	);

	const setKey = vscode.commands.registerCommand("chipAssistant.setApiKey", async () => {
		const value = await vscode.window.showInputBox({ prompt: "Enter OpenAI API Key", placeHolder: "sk-...", password: true, ignoreFocusOut: true });
		if (value) {
			await context.secrets.store("chipAssistant.openai.apiKey", value.trim());
			vscode.window.showInformationMessage("Chip Assistant: API key saved.");
		}
	});

	const clearKey = vscode.commands.registerCommand("chipAssistant.clearApiKey", async () => {
		await context.secrets.delete("chipAssistant.openai.apiKey");
		vscode.window.showInformationMessage("Chip Assistant: API key cleared.");
	});

	// Advanced Model Commands
	const toggleAdvancedModel = vscode.commands.registerCommand("chipAssistant.toggleAdvancedModel", async () => {
		const config = vscode.workspace.getConfiguration();
		const currentUseAdvanced = config.get<boolean>("chipAssistant.openai.useAdvancedModel", false);
		await config.update("chipAssistant.openai.useAdvancedModel", !currentUseAdvanced, vscode.ConfigurationTarget.Workspace);

		const newModel = !currentUseAdvanced ?
			config.get<string>("chipAssistant.openai.advancedModel", "gpt-4o") :
			config.get<string>("chipAssistant.openai.model", "o3-mini");

		vscode.window.showInformationMessage(
			`Chip Assistant: Switched to ${!currentUseAdvanced ? 'Advanced' : 'Standard'} model (${newModel})`
		);
	});

	const useAdvancedModel = vscode.commands.registerCommand("chipAssistant.useAdvancedModel", async () => {
		const config = vscode.workspace.getConfiguration();
		await config.update("chipAssistant.openai.useAdvancedModel", true, vscode.ConfigurationTarget.Workspace);

		const advancedModel = config.get<string>("chipAssistant.openai.advancedModel", "gpt-4o");
		vscode.window.showInformationMessage(`Chip Assistant: Using Advanced model (${advancedModel}) with large context window`);
	});

	const useStandardModel = vscode.commands.registerCommand("chipAssistant.useStandardModel", async () => {
		const config = vscode.workspace.getConfiguration();
		await config.update("chipAssistant.openai.useAdvancedModel", false, vscode.ConfigurationTarget.Workspace);

		const standardModel = config.get<string>("chipAssistant.openai.model", "o3-mini");
		vscode.window.showInformationMessage(`Chip Assistant: Using Standard model (${standardModel})`);
	});

	// OpenROAD: Set FLOW_HOME
	const setFlowHome = vscode.commands.registerCommand("openroad.setFlowHome", async () => {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			canSelectFiles: false,
			canSelectFolders: true,
			title: "Select OpenROAD-flow-scripts root (FLOW_HOME)",
			openLabel: "Use as FLOW_HOME",
		});
		if (!picked || picked.length === 0) {
			return;
		}
		const flowHome = picked[0].fsPath;
		await vscode.workspace.getConfiguration().update(
			"openroad.flow.flowHome",
			flowHome,
			vscode.ConfigurationTarget.Workspace
		);
		vscode.window.showInformationMessage(`OpenROAD FLOW_HOME set to: ${flowHome}`);
	});

	// OpenROAD: Configure Flow (wizard)
	const configureFlow = vscode.commands.registerCommand("openroad.configureFlow", async () => {
		await OpenroadConfigPanel.createOrShow(context);
	});

	// OpenROAD: Run Flow
	const runFlow = vscode.commands.registerCommand("openroad.runFlow", async () => {
		const runner = OpenroadRunner.getInstance();
		await runner.runFlow();
		updateOpenroadStatusItem();
	});

	// OpenROAD: Stop Flow
	const stopFlow = vscode.commands.registerCommand("openroad.stopFlow", async () => {
		const runner = OpenroadRunner.getInstance();
		runner.stopFlow();
		updateOpenroadStatusItem();
	});

	// OpenROAD: Clean All
	const cleanAll = vscode.commands.registerCommand("openroad.cleanAll", async () => {
		const runner = OpenroadRunner.getInstance();
		await runner.cleanAll();
		updateOpenroadStatusItem();
	});

	// Cocotb: Run Tests
	const runCocotbTests = vscode.commands.registerCommand("cocotb.runTests", async () => {
		const runner = CocotbRunner.getInstance();
		await runner.runTests();
	});

	// Cocotb: Stop Tests
	const stopCocotbTests = vscode.commands.registerCommand("cocotb.stopTests", () => {
		const runner = CocotbRunner.getInstance();
		runner.stopTests();
	});

	// Cocotb: Clean Tests
	const cleanCocotbTests = vscode.commands.registerCommand("cocotb.cleanTests", async () => {
		const runner = CocotbRunner.getInstance();
		await runner.cleanTests();
	});

	// Cocotb: Generate Makefile
	const generateCocotbMakefile = vscode.commands.registerCommand("cocotb.generateMakefile", async () => {
		const cfgDir = vscode.workspace.getConfiguration().get<string>("cocotb.testDirectory", "");
		const baseDir = cfgDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
		const designFile = await vscode.window.showInputBox({ prompt: "Enter design file path (relative or absolute)", placeHolder: "design.v" });
		if (!designFile) return;
		const testFile = await vscode.window.showInputBox({ prompt: "Enter test file path (relative or absolute)", placeHolder: "test_design.py" });
		if (!testFile) return;
		await vscode.commands.executeCommand("chipAssistant.generateCocotbMakefile", { testDir: baseDir, designFile, testFile });
	});

	// Chip Assistant: Generate Cocotb Makefile with AI
	const aiGenerateCocotbMakefile = vscode.commands.registerCommand("chipAssistant.generateCocotbMakefile", async (args?: { testDir?: string; designFile?: string; testFile?: string }) => {
		const testDir = args?.testDir || vscode.workspace.getConfiguration().get<string>("cocotb.testDirectory", "") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
		const designFile = args?.designFile || "design.v";
		const testFile = args?.testFile || "test_design.py";

		// Normalize possible multi-file input (comma/space separated)
		let designFiles = String(designFile).split(/[\s,]+/).filter(Boolean);
		if ((!designFiles || designFiles.length === 0 || designFiles[0] === "design.v") && testDir) {
			// Discover .v/.sv files in the selected Test Directory (depth 2)
			designFiles = listVerilogFiles(testDir, 2).map(p => path.relative(testDir, p));
		}
		const designFilesPreview = designFiles.map(f => `$(shell pwd)/${f}`).join(" \\\n\t");
		const testModule = path.basename(testFile, path.extname(testFile));
		const defaultTop = path.basename(designFiles[0] || "top", path.extname(designFiles[0] || "top"));

		const prompt = [
			"Generate a Cocotb Makefile in the directory below. Follow these exact rules:",
			"- TOPLEVEL_LANG ?= verilog (supports both .v and .sv)",
			"- VERILOG_SOURCES = list of design files, each prefixed with $(shell pwd)/",
			"  If multiple files: place each on its own line with a trailing backslash on all but the last line.",
			"  If only one file: a single line with NO trailing backslash.",
			"- COCOTB_TEST_MODULES = <basename of the Python test file (no .py)>",
			"- COCOTB_TOPLEVEL = top module name (if unknown, use basename of the first design file)",
			"- SIM = verilator",
			"- WAVES = 1",
			"- EXTRA_ARGS += --trace --trace-fst --trace-structs",
			"- include $(shell cocotb-config --makefiles)/Makefile.sim",
			"- TOPLEVEL_LANG, VERILOG_SOURCES, COCOTB_TEST_MODULES, COCOTB_TOPLEVEL, SIM, WAVES, EXTRA_ARGS, include must be present",
			"",
			`Directory: ${testDir}`,
			"Design files (use these in VERILOG_SOURCES with $(shell pwd)/ prefix):",
			designFiles.map(f => `- ${f}`).join("\n"),
			`Test file: ${testFile}`,
			`Computed values to use if needed: test module = ${testModule}, top default = ${defaultTop}`,
			"",
			"Return only the Makefile content in a single fenced code block."
		].join("\n");

		// Listen once for the next assistant message and auto-save
		const disposable = AITerminalProvider.onAssistantMessage(async (text) => {
			try {
				const content = extractFirstCodeFence(text) || text;
				if (!content || content.trim().length < 5) {
					return; // no useful content
				}
				if (!testDir) return;
				const outPath = path.join(testDir, "Makefile");
				fs.writeFileSync(outPath, content, { encoding: "utf8" });
				vscode.window.showInformationMessage(`Makefile saved to: ${outPath}`);
				try { await vscode.commands.executeCommand('workbench.view.explorer'); } catch { }
				try { await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(outPath)); } catch { }
			} finally {
				disposable.dispose();
			}
		});

		await aiTerminalProvider.askWithIntent("Generate Cocotb Makefile", prompt);
	});

	function extractFirstCodeFence(text: string): string | null {
		if (!text) return null;
		const match = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
		if (match && match[1]) {
			return match[1].replace(/\r\n/g, "\n");
		}
		return null;
	}

	function listVerilogFiles(rootDir: string, maxDepth: number): string[] {
		const results: string[] = [];
		try {
			const entries = fs.readdirSync(rootDir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(rootDir, entry.name);
				if (entry.isFile() && (entry.name.endsWith('.v') || entry.name.endsWith('.sv'))) {
					results.push(full);
				} else if (entry.isDirectory() && maxDepth > 0 && !['node_modules', '.git', '.vscode'].includes(entry.name)) {
					results.push(...listVerilogFiles(full, maxDepth - 1));
				}
			}
		} catch { }
		return results;
	}

	// Cocotb: Set Test Directory (Browse)
	const setCocotbTestDirectory = vscode.commands.registerCommand("cocotb.setTestDirectory", async () => {
		const runner = CocotbRunner.getInstance();
		await runner.setTestDirectory();
	});

	// Cocotb: Check Prerequisites
	const checkCocotbPrerequisites = vscode.commands.registerCommand("cocotb.checkPrerequisites", async () => {
		const runner = CocotbRunner.getInstance();
		const results = await runner.checkPrerequisites();

		let message = "Cocotb Prerequisites Check:\n";
		message += `Python: ${results.python ? "✓ OK" : "✗ Missing"}\n`;
		message += `Cocotb: ${results.cocotb ? "✓ OK" : "✗ Missing"}\n`;
		message += `Icarus (iverilog): ${results.icarus ? "✓ OK" : "✗ Missing"}\n`;
		message += `Verilator: ${results.verilator ? "✓ OK" : "✗ Missing"}\n`;
		message += `GTKWave: ${results.gtkwave ? "✓ OK" : "✗ Missing"}`;

		if (results.python && results.cocotb && results.icarus && results.gtkwave) {
			vscode.window.showInformationMessage(message);
		} else {
			// Offer to install missing components
			const actions = [];
			if (!results.cocotb) {
				actions.push("Install Cocotb");
			}
			if (!results.icarus) actions.push("Install Icarus");
			if (!results.gtkwave) actions.push("Install GTKWave");

			if (actions.length > 0) {
				const choice = await vscode.window.showWarningMessage(message, ...actions);
				if (choice === "Install Cocotb") {
					await runner.installCocotb();
				} else if (choice === "Install Icarus") {
					await runner.installSimulator();
				} else if (choice === "Install GTKWave") {
					await runner.installGtkwave();
				}
			} else {
				vscode.window.showWarningMessage(message);
			}
		}
	});

	// Cocotb: Install Cocotb
	const installCocotb = vscode.commands.registerCommand("cocotb.installCocotb", async () => {
		const runner = CocotbRunner.getInstance();
		await runner.installCocotb();
	});

	// Cocotb: Install Simulator
	const installSimulator = vscode.commands.registerCommand("cocotb.installSimulator", async () => {
		const runner = CocotbRunner.getInstance();
		await runner.installSimulator();
	});

	// Cocotb: Install GTKWave
	const installGtkwave = vscode.commands.registerCommand("cocotb.installGtkwave", async () => {
		const runner = CocotbRunner.getInstance();
		await runner.installGtkwave();
	});

	// Cocotb: Debug Simulator Detection
	const debugSimulatorDetection = vscode.commands.registerCommand("cocotb.debugSimulatorDetection", async () => {
		const runner = CocotbRunner.getInstance();
		await runner.debugSimulatorDetection();
	});

	// Cocotb: Generate Testbench
	const generateCocotbTestbench = vscode.commands.registerCommand("cocotb.generateTestbench", async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage("No active editor");
			return;
		}

		const selectedText = editor.document.getText(editor.selection);
		if (!selectedText) {
			vscode.window.showErrorMessage("Please select RTL code to generate testbench for");
			return;
		}

		// Use the same automated workflow as the code lens
		const prompt = "Generate a clean, production-ready Python Cocotb v2.0+ testbench for a Verilog systolic array module that performs vector-matrix multiplication, with dynamic array port detection, randomized and edge-case tests, proper signed 16-bit/32-bit handling, modern assertions, detailed logging, and no deprecated APIs. Do NOT import from cocotb.result or use TestFailure; use Python assertions (assert ...) and modern Cocotb v2.0+ APIs only. Do NOT use cocotb.binary.BinaryValue; instead use plain integers or cocotb.types (e.g., Bit, Logic, BitArray, LogicArray) for values.\n\n" + selectedText;
		await aiTerminalProvider._handleChatMessage(prompt);
	});

	function registerSelectionIntent(command: string, intentLabel: string) {
		return vscode.commands.registerCommand(command, async () => {
			const editor = vscode.window.activeTextEditor;
			const selection = editor?.selection;
			if (!editor || !selection || selection.isEmpty) {
				vscode.window.showInformationMessage("Select some text first.");
				return;
			}
			const selected = editor.document.getText(selection);
			await aiTerminalProvider.askWithIntent(intentLabel, selected);
		});
	}

	const explainCmd = registerSelectionIntent(
		"chipAssistant.explainSelection",
		"Explain the following code",
	);
	const bugsCmd = registerSelectionIntent(
		"chipAssistant.findBugsSelection",
		"Find potential bugs in the following code",
	);
	const svaCmd = registerSelectionIntent(
		"chipAssistant.assertionsSelection",
		"Generate SystemVerilog assertions for the following code",
	);
	const optCmd = registerSelectionIntent(
		"chipAssistant.optimizeSelection",
		"Optimize the following code",
	);
	const cocotbCmd = registerSelectionIntent(
		"chipAssistant.cocotbTestSelection",
		"Generate a clean, production-ready Python Cocotb v2.0+ testbench for a Verilog systolic array module that performs vector-matrix multiplication, with dynamic array port detection, randomized and edge-case tests, proper signed 16-bit/32-bit handling, modern assertions, detailed logging, and no deprecated APIs. Do NOT import from cocotb.result or use TestFailure; use Python assertions (assert ...) and modern Cocotb v2.0+ APIs only. Do NOT use cocotb.binary.BinaryValue; instead use plain integers or cocotb.types (e.g., Bit, Logic, BitArray, LogicArray) for values.",
	);

	// OpenROAD: Show Results Panel
	// const showResults = vscode.commands.registerCommand("openroad.showResults", async () => {
	// 	await OpenroadResultsPanel.show(context);
	// });

	context.subscriptions.push(
		showAITerminal,
		setKey,
		clearKey,
		toggleAdvancedModel,
		useAdvancedModel,
		useStandardModel,
		setFlowHome,
		configureFlow,
		runFlow,
		stopFlow,
		cleanAll,
		guiFinal,
		runCocotbTests,
		stopCocotbTests,
		cleanCocotbTests,
		generateCocotbMakefile,
		checkCocotbPrerequisites,
		installCocotb,
		installSimulator,
		debugSimulatorDetection,
		installGtkwave,
		generateCocotbTestbench,
		aiGenerateCocotbMakefile,
		setCocotbTestDirectory,
		explainCmd,
		bugsCmd,
		svaCmd,
		optCmd,
		cocotbCmd,
	);

	// Verilator commands
	context.subscriptions.push(
		vscode.commands.registerCommand("verilator.checkPrerequisites", async () => {
			const r = VerilatorRunner.getInstance();
			await r.checkPrerequisites();
		}),
		vscode.commands.registerCommand("verilator.compile", async () => {
			const r = VerilatorRunner.getInstance();
			await r.compile();
		}),
		vscode.commands.registerCommand("verilator.runSimulation", async () => {
			const r = VerilatorRunner.getInstance();
			await r.runSimulation();
		}),
		vscode.commands.registerCommand("verilator.stopSimulation", async () => {
			const r = VerilatorRunner.getInstance();
			await r.stopSimulation();
		}),
		vscode.commands.registerCommand("verilator.clean", async () => {
			const r = VerilatorRunner.getInstance();
			await r.clean();
		}),
		vscode.commands.registerCommand("verilator.setTestDirectory", async () => {
			const r = VerilatorRunner.getInstance();
			await r.setTestDirectory();
		}),
	);

	// Register inline CodeLens for selection intents
	const lensProvider = new SelectionIntentCodeLensProvider();
	const lensSelector: vscode.DocumentSelector = [{ scheme: "file" }, { scheme: "untitled" }];
	const lensRegistration = vscode.languages.registerCodeLensProvider(lensSelector, lensProvider);
	const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
		const editor = e.textEditor;
		if (!editor || e.selections.length === 0 || e.selections[0].isEmpty) {
			lensProvider.clear();
			return;
		}
		lensProvider.setActiveSelection(editor.document, e.selections[0]);
	});
	context.subscriptions.push(lensRegistration, selectionListener);
}

export function deactivate() { }
