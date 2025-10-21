## Verification Workbench Extension

This extension helps users complete verification and physical design tasks of RTL designs. It calls tools like cocotb and OpenROAD, and includes a user interface where the user can chat with an AI model. The extension also provides inline actions that the user may choose to perform.

To compile and run the extension under this feature branch:

```bash
# Compile the extension
cd extension/verificationi-workbench && npm run compile

# Go back to the root and run VS Code
cd ../../ && ./scripts/code.sh

