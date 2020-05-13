import Chunk from './Chunk';
import Graph from './Graph';
import {
	InputOptions,
	OutputBundle,
	OutputBundleWithPlaceholders,
	OutputChunk,
	OutputOptions
} from './rollup/types';
import { createAddons } from './utils/addons';
import { assignChunkIds } from './utils/assignChunkIds';
import commondir from './utils/commondir';
import { error } from './utils/error';
import getExportMode from './utils/getExportMode';
import { isAbsolute } from './utils/path';
import { PluginDriver } from './utils/PluginDriver';
import { timeEnd, timeStart } from './utils/timers';

export default class Bundle {
	constructor(
		private readonly graph: Graph,
		private readonly outputOptions: OutputOptions,
		private readonly inputOptions: InputOptions,
		private readonly pluginDriver: PluginDriver,
		private readonly chunks: Chunk[]
	) {
		if (outputOptions.dynamicImportFunction) {
			graph.warnDeprecation(
				`The "output.dynamicImportFunction" option is deprecated. Use the "renderDynamicImport" plugin hook instead.`,
				false
			);
		}
	}

	// TODO Lukas extract options into constructor, extract stuff and make nicer
	async generate(isWrite: boolean): Promise<OutputBundle> {
		timeStart('GENERATE', 1);
		const assetFileNames = this.outputOptions.assetFileNames || 'assets/[name]-[hash][extname]';
		const inputBase = commondir(getAbsoluteEntryModulePaths(this.chunks));
		const outputBundleWithPlaceholders: OutputBundleWithPlaceholders = Object.create(null);
		this.pluginDriver.setOutputBundle(outputBundleWithPlaceholders, assetFileNames);
		let outputBundle;

		try {
			await this.pluginDriver.hookParallel('renderStart', [this.outputOptions, this.inputOptions]);
			// TODO Lukas createChunks here
			if (this.chunks.length > 1) {
				validateOptionsForMultiChunkOutput(this.outputOptions);
			}

			const addons = await createAddons(this.outputOptions, this.pluginDriver);
			for (const chunk of this.chunks) {
				chunk.generateExports(this.outputOptions);
				if (
					this.inputOptions.preserveModules ||
					(chunk.facadeModule && chunk.facadeModule.isEntryPoint)
				)
					chunk.exportMode = getExportMode(chunk, this.outputOptions, chunk.facadeModule!.id);
			}
			for (const chunk of this.chunks) {
				chunk.preRender(this.outputOptions, inputBase, this.pluginDriver);
			}
			assignChunkIds(
				this.chunks,
				this.inputOptions,
				this.outputOptions,
				inputBase,
				addons,
				outputBundleWithPlaceholders,
				this.pluginDriver
			);
			outputBundle = assignChunksToBundle(this.chunks, outputBundleWithPlaceholders);

			await Promise.all(
				this.chunks.map(chunk => {
					const outputChunk = outputBundleWithPlaceholders[chunk.id!] as OutputChunk;
					return chunk
						.render(this.outputOptions, addons, outputChunk, this.pluginDriver)
						.then(rendered => {
							outputChunk.code = rendered.code;
							outputChunk.map = rendered.map;
						});
				})
			);
		} catch (error) {
			await this.pluginDriver.hookParallel('renderError', [error]);
			throw error;
		}
		await this.pluginDriver.hookSeq('generateBundle', [this.outputOptions, outputBundle, isWrite]);
		for (const key of Object.keys(outputBundle)) {
			const file = outputBundle[key] as any;
			if (!file.type) {
				this.graph.warnDeprecation(
					'A plugin is directly adding properties to the bundle object in the "generateBundle" hook. This is deprecated and will be removed in a future Rollup version, please use "this.emitFile" instead.',
					true
				);
				file.type = 'asset';
			}
		}
		this.pluginDriver.finaliseAssets();

		timeEnd('GENERATE', 1);
		return outputBundle;
	}
}

function getAbsoluteEntryModulePaths(chunks: Chunk[]): string[] {
	const absoluteEntryModulePaths: string[] = [];
	for (const chunk of chunks) {
		for (const entryModule of chunk.entryModules) {
			if (isAbsolute(entryModule.id)) {
				absoluteEntryModulePaths.push(entryModule.id);
			}
		}
	}
	return absoluteEntryModulePaths;
}

function validateOptionsForMultiChunkOutput(outputOptions: OutputOptions) {
	if (outputOptions.format === 'umd' || outputOptions.format === 'iife')
		return error({
			code: 'INVALID_OPTION',
			message: 'UMD and IIFE output formats are not supported for code-splitting builds.'
		});
	if (typeof outputOptions.file === 'string')
		return error({
			code: 'INVALID_OPTION',
			message:
				'When building multiple chunks, the "output.dir" option must be used, not "output.file". ' +
				'To inline dynamic imports, set the "inlineDynamicImports" option.'
		});
	if (outputOptions.sourcemapFile)
		return error({
			code: 'INVALID_OPTION',
			message: '"output.sourcemapFile" is only supported for single-file builds.'
		});
}

function assignChunksToBundle(
	chunks: Chunk[],
	outputBundle: OutputBundleWithPlaceholders
): OutputBundle {
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const facadeModule = chunk.facadeModule;

		outputBundle[chunk.id!] = {
			code: undefined as any,
			dynamicImports: chunk.getDynamicImportIds(),
			exports: chunk.getExportNames(),
			facadeModuleId: facadeModule && facadeModule.id,
			fileName: chunk.id,
			imports: chunk.getImportIds(),
			isDynamicEntry: chunk.isDynamicEntry,
			isEntry: facadeModule !== null && facadeModule.isEntryPoint,
			map: undefined,
			modules: chunk.renderedModules,
			get name() {
				return chunk.getChunkName();
			},
			type: 'chunk'
		} as OutputChunk;
	}
	return outputBundle as OutputBundle;
}
