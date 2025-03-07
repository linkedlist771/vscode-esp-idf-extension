/*
 * Project: ESP-IDF VSCode Extension
 * File Created: Friday, 27th September 2019 9:59:57 pm
 * Copyright 2019 Espressif Systems (Shanghai) CO LTD
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as path from "path";
import { constants } from "fs";
import { join } from "path";
import * as vscode from "vscode";
import * as idfConf from "../idfConfiguration";
import { FlashModel } from "./flashModel";
import {
  appendIdfAndToolsToPath,
  canAccessFile,
  execChildProcess,
  extensionContext,
  isBinInPath,
  isRunningInWsl,
} from "../utils";
import { TaskManager } from "../taskManager";
import { selectedDFUAdapterId } from "./dfu";

export class FlashTask {
  public static isFlashing: boolean;
  private workspaceUri: vscode.Uri;
  private flashScriptPath: string;
  private model: FlashModel;
  private buildDirName: string;

  constructor(workspace: vscode.Uri, idfPath: string, model: FlashModel) {
    this.workspaceUri = workspace;
    this.flashScriptPath = join(
      idfPath,
      "components",
      "esptool_py",
      "esptool",
      "esptool.py"
    );
    this.model = model;
    this.buildDirName = idfConf.readParameter(
      "idf.buildDirectoryName",
      workspace
    ) as string;
  }

  public flashing(flag: boolean) {
    FlashTask.isFlashing = flag;
  }

  private verifyArgs() {
    if (!canAccessFile(this.flashScriptPath, constants.R_OK)) {
      throw new Error("SCRIPT_PERMISSION_ERROR");
    }
    for (const flashFile of this.model.flashSections) {
      if (
        !canAccessFile(
          join(this.workspaceUri.fsPath, this.buildDirName, flashFile.binFilePath),
          constants.R_OK
        )
      ) {
        throw new Error("SECTION_BIN_FILE_NOT_ACCESSIBLE");
      }
    }
  }

  public async flash(flashType) {
    if (FlashTask.isFlashing) {
      throw new Error("ALREADY_FLASHING");
    }
    this.verifyArgs();
    const isSilentMode = idfConf.readParameter(
      "idf.notificationSilentMode",
      this.workspaceUri
    ) as boolean;
    const showTaskOutput = isSilentMode
      ? vscode.TaskRevealKind.Always
      : vscode.TaskRevealKind.Silent;
    let isWsl2Kernel = isRunningInWsl(this.workspaceUri);
    const powershellPath = await isBinInPath(
      "powershell.exe",
      this.workspaceUri.fsPath,
      process.env
    );
    let flashExecution: vscode.ShellExecution | vscode.ProcessExecution;
    if (process.platform === "linux" && isWsl2Kernel && powershellPath !== "") {
      flashExecution = await this._wslFlashExecution();
    } else {
      switch (flashType) {
        case "UART":
          flashExecution = this._flashExecution();
          break;
        case "DFU":
          flashExecution = this._dfuFlashing();
          break;
        default:
          break;
      }
    }
    const flashPresentationOptions = {
      reveal: showTaskOutput,
      showReuseMessage: false,
      clear: false,
      panel: vscode.TaskPanelKind.Shared,
    } as vscode.TaskPresentationOptions;
    TaskManager.addTask(
      { type: "esp-idf", command: "ESP-IDF Flash", taskId: "idf-flash-task" },
      vscode.TaskScope.Workspace,
      "ESP-IDF Flash",
      flashExecution,
      ["idfRelative", "idfAbsolute"],
      flashPresentationOptions
    );
  }

  public async _wslFlashExecution() {
    this.flashing(true);
    const modifiedEnv = appendIdfAndToolsToPath(this.workspaceUri);
    const wslRoot = extensionContext.extensionPath.replace(/\//g, "\\");
    const wslCurrPath = await execChildProcess(
      `powershell.exe -Command "(Get-Location).Path | Convert-Path"`,
      extensionContext.extensionPath
    );
    const winWslRoot = wslCurrPath.replace(wslRoot, "").replace(/[\r\n]+/g, "");
    const toolPath = (
      winWslRoot + this.flashScriptPath.replace(/\//g, "\\")
    ).replace(/\\/g, "\\\\");

    const flasherArgs = this.getFlasherArgs(toolPath, true);
    const options: vscode.ShellExecutionOptions = {
      cwd: join(this.workspaceUri.fsPath, this.buildDirName),
      env: modifiedEnv,
    };
    return new vscode.ShellExecution(
      `powershell.exe -Command "python ${flasherArgs.join(" ")}"`,
      options
    );
  }

  public _flashExecution() {
    this.flashing(true);
    const modifiedEnv = appendIdfAndToolsToPath(this.workspaceUri);
    const flasherArgs = this.getFlasherArgs(this.flashScriptPath);
    const options: vscode.ShellExecutionOptions = {
      cwd: join(this.workspaceUri.fsPath, this.buildDirName),
      env: modifiedEnv,
    };
    const pythonBinPath = idfConf.readParameter(
      "idf.pythonBinPath",
      this.workspaceUri
    ) as string;
    return new vscode.ProcessExecution(pythonBinPath, flasherArgs, options);
  }

  public _dfuFlashing() {
    this.flashing(true);
    const selectedDfuPath = idfConf.readParameter(
      "idf.selectedDfuDevicePath",
      this.workspaceUri
    );
    const listDfuDevices = idfConf.readParameter(
      "idf.listDfuDevices",
      this.workspaceUri
    );
    if (listDfuDevices.length > 1) {
      const idfPathDir = idfConf.readParameter(
        "idf.espIdfPath",
        this.workspaceUri
      ) as string;
      const pythonPath = idfConf.readParameter(
        "idf.pythonBinPath",
        this.workspaceUri
      ) as string;
      const idfPy = path.join(idfPathDir, "tools", "idf.py");
      return new vscode.ShellExecution(
        `${pythonPath} ${idfPy} dfu-flash --path ${selectedDfuPath}`
      );
    }
    return new vscode.ShellExecution(
      `dfu-util -d 303a:${selectedDFUAdapterId(this.model.chip)} -D ${join(
        this.workspaceUri.fsPath,
        this.buildDirName,
        "dfu.bin"
      )}`
    );
  }

  public getFlasherArgs(toolPath: string, replacePathSep: boolean = false) {
    const flasherArgs = [
      toolPath,
      "-p",
      this.model.port,
      "-b",
      this.model.baudRate,
      "--before",
      this.model.before,
      "--after",
      this.model.after,
    ];
    if (this.model.chip) {
      flasherArgs.push("--chip", this.model.chip);
    }
    if (typeof this.model.stub !== undefined && !this.model.stub) {
      flasherArgs.push("--no-stub");
    }
    flasherArgs.push(
      "write_flash",
      "--flash_mode",
      this.model.mode,
      "--flash_freq",
      this.model.frequency,
      "--flash_size",
      this.model.size
    );
    for (const flashFile of this.model.flashSections) {
      let binPath = replacePathSep
        ? flashFile.binFilePath.replace(/\//g, "\\")
        : flashFile.binFilePath;
      flasherArgs.push(flashFile.address, binPath);
    }
    if (
      this.model.encryptedFlashSections &&
      this.model.encryptedFlashSections.length
    ) {
      flasherArgs.push("--encrypt-files");
    }
    for (const flashFile of this.model.encryptedFlashSections) {
      let binPath = replacePathSep
        ? flashFile.binFilePath.replace(/\//g, "\\")
        : flashFile.binFilePath;
      flasherArgs.push(flashFile.address, binPath);
    }
    return flasherArgs;
  }
}
