"use strict";

import * as cp from "child_process";
import * as execa from "execa";
import * as getStream from "get-stream";
import * as path from "path";

import * as cmd from "./command";
import * as parse from "./parse";

import * as severity from "../src/severity";

import IdeExtensionProvider from "./ideExtensionProvider";

export default class ElixirLintingProvider {
  private static linterCommand: string = "mix";

  private command: any;

  private diagnosticCollection: any;

  private extension: any;

  private vscode: any;

  constructor(vscode) {
    this.vscode = vscode;
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
    this.extension = new IdeExtensionProvider(
      this.diagnosticCollection,
      this.command,
    );
  }

  /**
   * activate() and dispose() deal with set-up and tear-down in VS Code extensions.
   * The code below registers the command so that the CodeActionProvider can call it and
   *  sets up listeners to trigger the linting action.
   */

  public activate(subscriptions: any[], vscode = this.vscode) {
    this.extension.activate(this, subscriptions, vscode, this.linter);

    // Lint all open elixir documents
    vscode.workspace.textDocuments.forEach((item, index) => {
      this.linter(item, index, vscode);
    });
  }

  public dispose(): void {
    this.extension.dispose();
  }

  // getDiagnosis for vscode.diagnostics
  public getDiagnosis(item, vscode = this.vscode): any {
    const range = new vscode.Range(
      item.startLine,
      item.startColumn,
      item.endLine,
      item.endColumn,
    );
    const itemSeverity = severity.parse(item.check, vscode);
    const message = `${item.message} [${item.check}:${itemSeverity}]`;
    return new vscode.Diagnostic(range, message, itemSeverity);
  }

  public makeZeroIndex = (value: number): number => {
    if (value <= 0) {
      return 0;
    }

    return value - 1;
  }

  public getDiagnosticInfo = (lineInfo): any => {
    if (!lineInfo) {
      return;
    }

    const isNotAnumber =
      isNaN(parseInt(lineInfo.position, 10)) ||
      isNaN(parseInt(lineInfo.column, 10));
    const isLessThanOrEqualToZero =
      lineInfo.position <= 0 || lineInfo.column <= 0;

    if (isNotAnumber || isLessThanOrEqualToZero) {
      return;
    }

    return {
      check: lineInfo.check,
      endColumn: this.makeZeroIndex(lineInfo.column),
      endLine: this.makeZeroIndex(lineInfo.position),
      message: lineInfo.message,
      startColumn: 0,
      startLine: this.makeZeroIndex(lineInfo.position),
    };
  }

  public parseOutput(output) {
    return parse.getLines(output).map((error) => {
      const lineInfo = parse.getLineInfo(error);

      return this.getDiagnosticInfo(lineInfo);
    });
  }

  public parseInfoOutput(output): string[] {
    const json = parse.getLines(output).join("\n");
    const info = JSON.parse(json);
    return info.config ? info.config.files : [];
  }

  /**
   * Using cp.spawn(), extensions can call any executable and process the results.
   * The code below uses cp.spawn() to call linter, parses the output into Diagnostic objects
   * and then adds them to a DiagnosticCollection with this.diagnosticCollection.set(textDocument.uri, diagnostics);
   * which add the chrome in the UI.
   */

  private linter(textDocument: any, index, vscode = this.vscode) {
    if (textDocument.languageId !== "elixir") {
      return;
    }

    this.getLintedFiles(vscode, (files) => {
      if (files.indexOf(textDocument.fileName) === -1) {
        return;
      }

      let args = ["credo", "list", "--format=oneline", "--read-from-stdin"];

      const settings = vscode.workspace.getConfiguration("elixirLinter");
      if (settings.useStrict === true) {
        args = args.concat("--strict");
      }

      // use stdin for credo to prevent running on entire project
      const childProcess = execa(
        ElixirLintingProvider.linterCommand,
        args,
        cmd.getOptions(vscode),
      );
      childProcess.stdin.write(textDocument.getText());
      childProcess.stdin.end();

      childProcess.then((decoded) => {
        this.handleFileDiagnosticOutput(decoded, textDocument, vscode);
      });

      //   childProcess.stdout.on("data", (data: Buffer) => {
      //         decoded += data;
      //     });
      //   childProcess.stdout.on("end", () => this.handleFileDiagnosticOutput(decoded, textDocument, vscode))

      //   stream.pipe(textDocument.getText());
      //   getStream(stream)
      //     .then(stdout => this.handleFileDiagnosticOutput(stdout, textDocument, vscode))
      //     .catch(error => this.handleFileDiagnosticError(error));

      //   if (childProcess.pid) {
      //       childProcess.stdout.on("data", (data: Buffer) => {
      //           decoded += data;
      //       });
      //       childProcess.stdout.on("end", () => this.handleFileDiagnosisOutput(decoded, textDocument, vscode));
      //   }
    });
  }

  private handleFileDiagnosticError(error) {
    console.warn(`Elixir linter error: ${error}`);
  }

  private handleFileDiagnosticOutput(decoded, textDocument, vscode) {
    const diagnostics: any[] = [];

    this.parseOutput(decoded).forEach((item) => {
      if (item) {
        diagnostics.push(this.getDiagnosis(item, vscode));
      }
    });
    this.diagnosticCollection.set(textDocument.uri, diagnostics);
  }

  private handleCredoFileOutput(decoded, callback, vscode) {
    const files = this.parseInfoOutput(decoded).map((item) => {
      return path.join(vscode.workspace.rootPath, item);
    });
    callback(files);
  }

  private getLintedFiles(
    vscode = this.vscode,
    callback: (files: string[]) => void,
  ) {
    let decoded = "";
    const args = ["credo", "info", "--verbose", "--format=json"];

    const childProcess = execa
      .stdout(ElixirLintingProvider.linterCommand, args, cmd.getOptions(vscode))
      .then((stdout) => this.handleCredoFileOutput(stdout, callback, vscode));

    if (childProcess.pid) {
      childProcess.stdout.on("data", (data: Buffer) => {
        decoded += data;
      });
      childProcess.stdout.on("end", () =>
        this.handleCredoFileOutput(decoded, callback, vscode),
      );
    } else {
      callback([]);
    }
  }
}
