// The parts of the scmActionButton and scmValidation proposed APIs that the source control view uses.

declare module 'vscode' {
	export interface SourceControl {
		/** Large button under the message box; its command runs on click. */
		actionButton?: SourceControlActionButton;
	}

	export interface SourceControlActionButton {
		command: Command;
		/** Extra commands shown in the button's drop-down, in groups. */
		secondaryCommands?: Command[][];
		enabled: boolean;
	}

	export enum SourceControlInputBoxValidationType {
		Error = 0,
		Warning = 1,
		Information = 2,
	}

	export interface SourceControlInputBoxValidation {
		readonly message: string;
		readonly type: SourceControlInputBoxValidationType;
	}

	export interface SourceControlInputBox {
		/** Called as the text changes; a result shows a note under the box. */
		validateInput?(value: string, cursorPosition: number): ProviderResult<SourceControlInputBoxValidation>;
	}
}
