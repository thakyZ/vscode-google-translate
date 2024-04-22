import { Selection, Range, workspace, window, ConfigurationTarget, commands, extensions, ExtensionContext, Position, Extension, TextEditorEdit, env } from "vscode";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Language, Languages } from "./languages";
import { RawResponse, TranslateOptions } from "@vitalets/google-translate-api/dist/cjs/types";
import { HttpsProxyOptions, httpsOverHttp } from 'tunnel';
import * as he from "he";
import * as path from "node:path";
import {
  LanguageClient,
  LanguageClientOptions,
  TransportKind
} from 'vscode-languageclient/node';
import { Agent } from "node:http";
const camelcase = require("camelcase");
const humanizeString = require("humanize-string");
const gti = require("@vitalets/google-translate-api");

type TranslatorRes = { text: string; raw: RawResponse; }
type QuickPickData = readonly string[] | Thenable<readonly string[]>

interface TranslateRes {
  translation: string;
  raw: RawResponse;
  selection: Selection;
  data?: any[];
}

interface ProxyAuthConfig {
  username: string;
  password: string;
}

interface ProxyConfig {
  host?: string,
  port?: string,
  username?: string,
  password?: string,
  auth?: ProxyAuthConfig;
}

interface InteralProxyConfig {
  host: string,
  port: number,
  username?: string,
  password?: string,
  auth?: ProxyAuthConfig;
}

interface TranslationConfiguration {
  to?: string;
  proxy?: InteralProxyConfig;
  agent?: Agent;
}

interface GrammarExtension {
    languages: Language[];
    value: {};
    extensionLocation: string;
}

async function translate(text: string, options: TranslationConfiguration): Promise<TranslatorRes> {
  const gotopts: TranslateOptions = { to: "en", fetchOptions: {} };
  if (options && options.proxy) {
    gotopts.to = options.to ?? "en";
    const proxy: HttpsProxyOptions = {
      host: options.proxy.host,
      port: options.proxy.port,
      headers: {
        "User-Agent": "Node",
      },
    };
    if (options.proxy.auth) {
      proxy.proxyAuth = `${options.proxy.auth.username}:${options.proxy.auth.password}`;
    }

    gotopts.fetchOptions = {
      agent: httpsOverHttp({proxy: proxy})
    };
  }
  return await gti(text, gotopts);
}

/**
 * The list of recently used languages
 */
const recentlyUsed: string[] = [];

let client: LanguageClient;

/**
 * Updates languages lists for the convenience of users
 *
 * @param {string} selectedLanguage The language code to update
 */
function updateLanguageList(selectedLanguage: string): void {
  const index = recentlyUsed.findIndex((r) => r === selectedLanguage);
  if (index !== -1) {
    // Remove the recently used language from the list
    recentlyUsed.splice(index, 1);
  }
  // Add the language in recently used languages
  recentlyUsed.splice(0, 0, selectedLanguage);
}

/**
 * Extracts a text from the active document selection
 *
 * @param {vscode.TextDocument} document The current document
 * @param {vscode.Selection} selection The current selection
 * @returns {string} A text
 */
function getSelectedText(document: TextDocument, selection: Selection): string {
  const charRange = new Range(
    selection.start.line,
    selection.start.character,
    selection.end.line,
    selection.end.character
  );
  return document.getText(charRange);
}

/**
 * Gets a text of the first line from active selection
 *
 * @param {vscode.TextDocument} document The current document
 * @param {vscode.Selection} selection The current selection
 */
function getSelectedLineText(document: TextDocument, selection: Selection): string {
  return document.getText(new Range(selection.start, selection.end));
}

/**
 * Translates the selectedText to the selectedLanguage like a Promise
 *
 * @param {string} selectedText Text
 * @param {string} selectedLanguage Language
 * @param {vscode.Selection} selection Selection
 */
function getTranslationPromise(selectedText: string, selectedLanguage: string, selection: Selection): Promise<TranslateRes> {
  return new Promise<TranslateRes>((resolve: (r: TranslateRes) => void, reject: (reason?: any) => void) => {
    const { host, port, username, password } = getProxyConfig();
    const translationConfiguration: TranslationConfiguration = {
      to: selectedLanguage,
    };
    if (!!host) {
      translationConfiguration.proxy = {
        host,
        port: Number(port),
      };
      if (!!username && !!password) {
        translationConfiguration.proxy.auth = {
          username,
          password,
        };
      }
    }
    translate(selectedText, translationConfiguration).then((translateRes: TranslatorRes) => {
      if (!!translateRes && !!translateRes.text) {
        // If google rejects the string it will return the same string as input
        // We can try to split the string into parts, then translate again. Then return it to a
        // camel style casing
        if (translateRes.text === selectedText) {
          translate(humanizeString(selectedText), translationConfiguration).then((translatorRes: TranslatorRes) => {
            if (!!translatorRes.text && !!translateRes.text) {
              resolve({selection, translation: camelcase(translateRes.text)} as TranslateRes);
            } else {
              reject(new Error("Google Translation API issue"));
            }
          });
        } else {
          resolve({selection, translation: translateRes.text} as TranslateRes);
        }
      } else {
        reject(new Error("Google Translation API issue"));
      }
    }).catch((e: any) => reject(new Error("Google Translation API issue: " + e.message)));
  });
}

/**
 * Generates the array of promises based on selections
 *
 * @param {Array.<Selection>} selections Array of selections
 * @param {vscode.TextDocument} document The current document
 * @param {string} selectedLanguage The current language
 */
function getTranslationsPromiseArray(selections: readonly Selection[], document: TextDocument, selectedLanguage: string): Promise<TranslateRes>[] {
  return selections.map((selection: Selection) => {
    const selectedText = getSelectedText(document, selection);
    return getTranslationPromise(selectedText, selectedLanguage, selection);
  });
}

/**
 * Gets arrays of Translation Promises based on the first lines under the cursor.
 *
 * @param {vscode.Selection[]} selections The current selection
 * @param {vscode.TextDocument} document The current document
 * @param {string} selectedLanguage
 */
function getTranslationsPromiseArrayLine(selections: readonly Selection[], document: TextDocument, selectedLanguage: string): Promise<TranslateRes>[] {
  return selections.map((selection: Selection) => {
    const selectedLineText = getSelectedLineText(document, selection);
    return getTranslationPromise(selectedLineText, selectedLanguage, selection);
  });
}

/**
 * Returns user settings Preferred language.
 * If user hasn't set preferred lang. Prompt to set.
 */
function getPreferredLanguage(): Promise<string | undefined> {
  return workspace.getConfiguration("vscodeGoogleTranslate").get("preferredLanguage") || setPreferredLanguage();
}

async function setPreferredLanguage(): Promise<string | undefined> {
  const quickPickData: QuickPickData = Languages.map((r: Language) => r.name);

  const selectedLanguage: string | undefined = await window.showQuickPick(quickPickData);
  workspace.getConfiguration().update("vscodeGoogleTranslate.preferredLanguage", selectedLanguage, ConfigurationTarget.Global);
  return selectedLanguage;
}

/**
 * Returns user settings proxy config
 */
function getProxyConfig(): ProxyConfig {
  const config = workspace.getConfiguration("vscodeGoogleTranslate");
  return {
    host: config.get("proxyHost"),
    port: config.get("proxyPort"),
    username: config.get("proxyUsername"),
    password: config.get("proxyPassword"),
  };
}

/**
 * Platform binding function
 *
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<undefined>} There is no an API public surface now (7/3/2019)
 */
async function activate(context: ExtensionContext): Promise<void> {
  const translateText = commands.registerCommand(
    "extension.translateText",
    function () {
      const editor = window.activeTextEditor;
      if (!editor) return;
      const { document, selections } = editor;

      const quickPickData: QuickPickData = Languages.map((r: Language) => r.name);

      window.showQuickPick(quickPickData).then((selectedLanguage: string | undefined) => {
          if (!selectedLanguage) return;
          const _selectedLanguage: Language | undefined = Languages.find((r: Language) => r.name === selectedLanguage);
          if (_selectedLanguage) updateLanguageList(_selectedLanguage.name);
          const translationsPromiseArray = getTranslationsPromiseArray(selections, document as unknown as TextDocument, _selectedLanguage?.value ?? "en");
          Promise.all(translationsPromiseArray)
            .then(function (results) {
              editor.edit((builder) => {
                results.forEach((r) => {
                  if (!!r.translation) {
                    builder.replace(r.selection, he.decode(r.translation));
                  }
                });
              });
            }).catch((e: any) => window.showErrorMessage(e.message));
        }, (err: any) => {
          window.showErrorMessage(err.message);
        });
    }
  );
  context.subscriptions.push(translateText);

  const setPreferredLanguageFnc = commands.registerCommand(
    "extension.setPreferredLanguage",
    setPreferredLanguage
  );
  context.subscriptions.push(setPreferredLanguageFnc);

  const translateTextPreferred = commands.registerCommand(
    "extension.translateTextPreferred",
    async function () {
      const editor = window.activeTextEditor;
      if (!editor) return;
      const { document, selections } = editor;

      // vscodeTranslate.preferredLanguage
      const preferredLanguage: string | undefined = await getPreferredLanguage();
      const locale: string = Languages.find((element: Language) => element.name === preferredLanguage)?.value ?? "en";
      if (!locale) return;

      const translationsPromiseArray = getTranslationsPromiseArray(selections, document as unknown as TextDocument, locale);
      Promise.all(translationsPromiseArray).then(function (results: TranslateRes[]) {
        editor.edit((builder: TextEditorEdit) => {
          results.forEach((r: TranslateRes) => {
            if (!!r.translation) {
              builder.replace(r.selection, he.decode(r.translation));
            }
          });
        });
      }).catch((e: any) => window.showErrorMessage(e.message));
    }
  );
  context.subscriptions.push(translateTextPreferred);

  const translateLinesUnderCursor = commands.registerCommand(
    "extension.translateLinesUnderCursor",
    function translateLinesUnderCursorcallback() {
      const editor = window.activeTextEditor;
      if (!editor) return;
      const { document, selections } = editor;

      const quickPickData: QuickPickData = Languages.map((r: Language) => r.name);

      window.showQuickPick(quickPickData).then((selectedLanguage?: string) => {
        if (!selectedLanguage) return;
        const _selectedLanguage: Language | undefined = Languages.find((r: Language) => r.name == selectedLanguage);
        if (_selectedLanguage) updateLanguageList(_selectedLanguage.name);
        const translationsPromiseArray = getTranslationsPromiseArrayLine(selections, document as unknown as TextDocument, _selectedLanguage?.value ?? "en");
        Promise.all(translationsPromiseArray)
          .then(function (results: TranslateRes[]) {
            editor.edit((builder: TextEditorEdit) => {
              results.forEach((r: TranslateRes) => {
                if (!!r.translation) {
                  const ffix = ["", "\n"];
                  if (editor.document.lineCount - 1 === r.selection.start.line) [ffix[0], ffix[1]] = [ffix[1], ffix[0]];
                  const p = new Position(r.selection.start.line + 1, 0);
                  builder.insert(p, `${ffix[0]}${r.translation}${ffix[1]}`);
                }
              });
            });
          })
          .catch((e: any) => window.showErrorMessage(e.message));
      }, (err: any) => {
        window.showErrorMessage(err.message);
      });
    }
  );

  context.subscriptions.push(translateLinesUnderCursor);

  const translateLinesUnderCursorPreferred = commands.registerCommand(
    "extension.translateLinesUnderCursorPreferred",
    async function translateLinesUnderCursorPreferredcallback() {
      const editor = window.activeTextEditor;
      if (!editor) return;
      const { document, selections } = editor;
      const preferredLanguage: string | undefined = await getPreferredLanguage();
      const locale = Languages.find((element: Language) => element.name === preferredLanguage)?.value ?? "en";
      if (!locale) {
        window.showWarningMessage("Preferred language is required for this feature! Please set this in the settings.");
        return;
      }

      const translationsPromiseArray: Promise<TranslateRes>[] = getTranslationsPromiseArrayLine(selections, document as unknown as TextDocument, locale);

      Promise.all(translationsPromiseArray).then(function (results: TranslateRes[]) {
        editor.edit((builder: TextEditorEdit) => {
          results.forEach((r: TranslateRes) => {
            if (!!r.translation) {
              const ffix = ["", "\n"];
              if (editor.document.lineCount - 1 === r.selection.start.line) [ffix[0], ffix[1]] = [ffix[1], ffix[0]];
              const p = new Position(r.selection.start.line + 1, 0);
              builder.insert(p, `${ffix[0]}${r.translation}${ffix[1]}`);
            }
          });
        });
      }).catch((e) => window.showErrorMessage(e.message));
    }
  );
  context.subscriptions.push(translateLinesUnderCursorPreferred);

  // Don't initialize the server if it's not wanted
  if (
    !workspace
      .getConfiguration("vscodeGoogleTranslate")
      .get("HoverTranslations")
  ) {
    return;
  }

  // All Below code initializes the Comment Hovering Translation feature
  let serverModule = context.asAbsolutePath(
    path.join("server", "out", "server.js")
  );
  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  let debugOptions = { execArgv: ["--nolazy", "--inspect=16009"] };
  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  let serverOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };
  let extAll: readonly Extension<any>[] = extensions.all;
  let languageId: number = 2;
  let grammarExtensions: GrammarExtension[] = [];
  let canLanguages: string[] = [];
  extAll.forEach((extension: Extension<any>) => {
    if (!(extension.packageJSON.contributes && extension.packageJSON.contributes.grammars)) return;
    let languages = [];
    ((extension.packageJSON.contributes && extension.packageJSON.contributes.languages) || []).forEach((language: {id:string}) => {
      languages.push({
        id: languageId++,
        name: language.id,
      });
    });
    grammarExtensions.push({
      languages: Languages,
      value:
        extension.packageJSON.contributes &&
        extension.packageJSON.contributes.grammars,
      extensionLocation: extension.extensionPath,
    });
    canLanguages = canLanguages.concat(extension.packageJSON.contributes.grammars.map((g: {language:string}) => g.language));
  });
  let BlackLanguage = ["log", "Log"];
  let userLanguage = env.language;
  // Options to control the language client
  let clientOptions: LanguageClientOptions  = {
    // Register the server for plain text documents
    revealOutputChannelOn: 4,
    initializationOptions: {
      grammarExtensions,
      appRoot: env.appRoot,
      userLanguage,
    },
    documentSelector: canLanguages
      .filter((v) => v)
      .filter((v) => BlackLanguage.indexOf(v) < 0),
  };
  // Create the language client and start the client.
  client = new LanguageClient(
    "CommentTranslate",
    "Comment Translate",
    serverOptions,
    clientOptions
  );
  // Start the client. This will also launch the server
  await client.start();
  client.onRequest("selectionContains", (textDocumentPosition) => {
    let editor = window.activeTextEditor;
    if (editor && editor.document.uri.toString() === textDocumentPosition.textDocument.uri) {
      let position = new Position(
        textDocumentPosition.position.line,
        textDocumentPosition.position.character
      );
      let selection = editor.selections.find((selection) => {
        return !selection.isEmpty && selection.contains(position);
      });
      if (selection) {
        return {
          range: selection,
          comment: editor.document.getText(selection),
        };
      }
    }
    return undefined;
  });
}
exports.activate = activate;

/**
 * Platform binding function
 * this method is called when your extension is deactivated
 *
 * @returns {Promise<void>} There is no an API public surface now (7/3/2019)
 */
async function deactivate(context: ExtensionContext): Promise<void> {
  if (!client) return;
  return client.stop();
}
exports.deactivate = deactivate;
