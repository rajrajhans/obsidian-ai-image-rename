import {
	App,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";
import * as path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	dangerouslyAllowBrowser: true,
});

const PASTED_IMAGE_PREFIX = "Pasted image ";

interface ImageRenamePluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: ImageRenamePluginSettings = {
	mySetting: "default",
};

export default class ImageRenamePlugin extends Plugin {
	settings: ImageRenamePluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ImageRenamePluginSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!(file instanceof TFile)) return;
				const timeGapMs = new Date().getTime() - file.stat.ctime;

				// if the file is created more than 1 second ago, the event is most likely be fired on vault initialization when starting Obsidian app, ignore it
				if (timeGapMs > 1000) return;

				// always ignore markdown file creation
				if (isMarkdownFile(file)) return;

				if (isPastedImage(file)) {
					this.renameFile(file);
				}
			})
		);
	}

	async renameFile(file: TFile) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const activeFile = view?.file;

		if (!file.parent || !activeFile) {
			new Notice(`Failed to rename: parent / activeFile is null`);
			return;
		}

		const newNameGenerated = await this.generateImageFileName(
			file,
			activeFile.name
		);
		if (!newNameGenerated) {
			new Notice(`Failed to generate image name for ${file.name}`);
			return;
		}
		const { name: newName } = await this.deduplicateNewName(
			newNameGenerated,
			file
		);
		const originName = file.name;

		let linkText = this.app.fileManager.generateMarkdownLink(
			file,
			activeFile.path
		);

		linkText = removeDirectoryPath(linkText);

		const newPath = path.join(file.parent.path, newName);
		try {
			await this.app.fileManager.renameFile(file, newPath);
		} catch (err) {
			new Notice(`Failed to rename ${newName}: ${err}`);
			throw err;
		}

		const newLinkText = this.app.fileManager.generateMarkdownLink(
			file,
			activeFile.path
		);

		const editor = view?.editor;
		if (!editor) {
			new Notice(`Failed to rename ${newName}: no active editor`);
			return;
		}

		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const replacedLine = line.replace(linkText, newLinkText);

		editor.transaction({
			changes: [
				{
					from: { ...cursor, ch: 0 },
					to: { ...cursor, ch: line.length },
					text: replacedLine,
				},
			],
		});

		new Notice(`Renamed ${originName} to ${newName}`);
	}

	async deduplicateNewName(newName: string, file: TFile): Promise<NameObj> {
		// list files in dir
		const dir = file.parent?.path;
		if (!dir) {
			throw new Error("Parent directory is null");
		}
		const listed = await this.app.vault.adapter.list(dir);

		// parse newName
		const newNameExt = path.extname(newName),
			newNameStem = newName.slice(
				0,
				newName.length - newNameExt.length - 1
			),
			newNameStemEscaped = escapeRegExp(newNameStem),
			delimiter = "_",
			delimiterEscaped = escapeRegExp(delimiter);

		let dupNameRegex;

		dupNameRegex = new RegExp(
			`^(?<number>\\d+)${delimiterEscaped}(?<name>${newNameStemEscaped})\\.${newNameExt}$`
		);

		const dupNameNumbers: number[] = [];
		let isNewNameExist = false;
		for (let sibling of listed.files) {
			sibling = path.basename(sibling);
			if (sibling == newName) {
				isNewNameExist = true;
				continue;
			}

			// match dupNames
			const m = dupNameRegex.exec(sibling);
			if (!m) continue;
			// parse int for m.groups.number
			if (m.groups) {
				dupNameNumbers.push(parseInt(m.groups.number));
			}
		}

		if (isNewNameExist) {
			// get max number
			const newNumber =
				dupNameNumbers.length > 0 ? Math.max(...dupNameNumbers) + 1 : 1;
			// change newName
			newName = `${newNameStem}${delimiter}${newNumber}.${newNameExt}`;
		}

		return {
			name: newName,
			stem: newName.slice(0, newName.length - newNameExt.length - 1),
			extension: newNameExt,
		};
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async generateImageFileName(file: TFile, noteName: string) {
		const dataUrl = await this.getBase64ImageUrl(file);
		if (!dataUrl) {
			console.error("Failed to get base64 image url");
			return null;
		}
		try {
			const response = await openai.chat.completions.create({
				model: "gpt-4o",
				messages: [
					{
						role: "system",
						content: `
    The user has pasted an image into a note. Generate a concise and descriptive file name for this image. Along with the image, you will be given the title of the note as a reference. Try to include the title of note in the image. But the file name should based more on the actual image rather than the title of the note. The generated file name should describe well what is in the image.
    The file name should be lowercase, use hyphens instead of spaces, and include the appropriate file extension.
    Give only the generated file name as the output, nothing else.
        `,
					},
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `
          Title of the note: ${noteName}
          Output:
          `,
							},
							{
								type: "image_url",
								image_url: {
									url: dataUrl,
								},
							},
						],
					},
				],
			});

			return response.choices[0]?.message?.content?.trim() ?? null;
		} catch (error) {
			console.error("Error:", error);
			return null;
		}
	}

	async getBase64ImageUrl(file: TFile) {
		try {
			const arrayBuffer = await this.app.vault.adapter.readBinary(
				file.path
			);

			const base64 = btoa(
				new Uint8Array(arrayBuffer).reduce(
					(data, byte) => data + String.fromCharCode(byte),
					""
				)
			);

			return `data:image/jpeg;base64,${base64}`;
		} catch (error) {
			console.error("Error reading file:", error);
			return null;
		}
	}
}

function removeDirectoryPath(linkText: string) {
	const match = linkText.match(/\[\[(.*?)\]\]/);
	if (match && match[1]) {
		let path = match[1];
		const fileName = path.split("/").pop();
		return `![[${fileName}]]`;
	}
	return linkText;
}

function escapeRegExp(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPastedImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (file.name.startsWith(PASTED_IMAGE_PREFIX)) {
			return true;
		}
	}
	return false;
}

function isMarkdownFile(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (file.extension === "md") {
			return true;
		}
	}
	return false;
}

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "bmp", "svg"];

function isImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (IMAGE_EXTS.contains(file.extension.toLowerCase())) {
			return true;
		}
	}
	return false;
}

class ImageRenamePluginSettingTab extends PluginSettingTab {
	plugin: ImageRenamePlugin;

	constructor(app: App, plugin: ImageRenamePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Setting #1")
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder("Enter your secret")
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

export interface NameObj {
	name: string;
	stem: string;
	extension: string;
}
