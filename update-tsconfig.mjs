import fs from "node:fs/promises";
import { relative } from "node:path";
import ts from "typescript";

// eslint-disable-next-line no-extra-parens
const filterTruthy = /** @type {<Type>(value: Type) => value is Exclude<Type, null | undefined>} */(Boolean);

/** @type Record<"references", Record<"path", string>[]> */
const projectConfig =
	// eslint-disable-next-line no-new-func
	new Function(`return ${await fs.readFile("tsconfig.json", "utf8")}`)();

const projectMap = new Map(await Promise.all(
	projectConfig.references.map(async ({ path }) => {
		const [ packageJsonText, sourceText ] = await Promise.all([
			fs.readFile(`${path}/package.json`, "utf8"),
			fs.readFile(`${path}/tsconfig.json`, "utf8"),
		]);
		/** @type {{ name: string; dependencies?: Record<string, string>, exports?: Record<string, { "types"?: string }> }} */
		const packageJson = JSON.parse(packageJsonText);
		const tsconfig = ts.parseJsonText("tsconfig.json", sourceText);
		// eslint-disable-next-line no-new-func
		const tsconfigJson = new Function(`return ${sourceText}`)();
		const json = tsconfig.statements[0]?.expression;
		const positions = function() {
			if (json && ts.isObjectLiteralExpression(json)) {
				const compilerOptions = json.properties.find(property =>
					property.name && ts.isStringLiteral(property.name) && property.name.text === "compilerOptions");
				const references = json.properties.find(property =>
					property.name && ts.isStringLiteral(property.name) && property.name.text === "references");
				if (
					references &&
					ts.isPropertyAssignment(references) &&
					compilerOptions &&
					ts.isPropertyAssignment(compilerOptions) &&
					ts.isObjectLiteralExpression(compilerOptions.initializer)
				) {
					const paths = compilerOptions.initializer.properties.find(property =>
						property.name && ts.isStringLiteral(property.name) && property.name.text === "paths");
					if (paths) {
						return {
							references: {
								start: references.pos,
								end: references.end,
							},
							paths: {
								start: paths.pos,
								end: paths.end,
							},
						};
					}
				}
			}
		}();
		const moduleResolution = tsconfigJson.compilerOptions?.moduleResolution;
		const dependencies = Object.keys(packageJson.dependencies ?? {}).sort();
		const { name, exports } = packageJson;
		/** @type {string} */
		const outDir = tsconfigJson.compilerOptions.outDir;
		// eslint-disable-next-line no-extra-parens
		const entry = /** @type {const} */ ([
			name,
			{ ...positions, path, exports, outDir, dependencies, moduleResolution, sourceText },
		]);
		return entry;
	}),
));

await Promise.all(function*() {
	for (const [ name, { path, dependencies, moduleResolution, sourceText, paths, references } ] of projectMap) {
		if (sourceText.includes("@no-automatic-paths")) {
			continue;
		}
		if (paths && references) {
			yield async function() {
				const pathsEntries = [
					...dependencies.filter(dependency => dependency !== name),
					name,
				]
					// eslint-disable-next-line array-callback-return
					.flatMap(dependency => {
						const record = projectMap.get(dependency);
						if (record) {
							const { exports, outDir } = record;
							if (exports) {
								// eslint-disable-next-line array-callback-return
								return Object.entries(exports).map(([ specifier, exports ]) => {
									const types = exports.types;
									const pattern = types && types.replace(`./${outDir}/`, "").replace(/\.d\.ts$/, ".ts");
									if (pattern && specifier.startsWith("./")) {
										return {
											from: `${dependency}/${specifier.slice(2)}`,
											to: [ `${relative(path, record.path) || "."}/${pattern}` ],
										};
									}
								});
							} else if (moduleResolution === "node" && name === dependency) {
								return {
									from: `${dependency}/*`,
									to: [ "./*.ts", "./*/index.ts" ],
								};
							}
						}
					})
					.filter(filterTruthy);
				const referencesEntries = dependencies
					.filter(dependency => dependency !== name)
					.map(dependency => projectMap.get(dependency)?.path)
					.filter(filterTruthy);
				const slices = [
					{
						start: paths.start,
						/** @param text {string} */
						fn: text =>
						// eslint-disable-next-line indent
`${text.slice(0, paths.start).replace(/(\s+|\/\/.+)$/, "")}
\t\t// vv Generated dependencies, do not modify vv
\t\t"paths": {
${pathsEntries.map(({ from, to }) => `\t\t\t${JSON.stringify(from)}: [ ${to.map(path => JSON.stringify(path)).join(", ")} ],\n`).join("")}\t\t},
\t\t// ^^ Generated dependencies, do not modify ^^
${text.slice(paths.end).replace(/^[,\s]*\n(?:\s+\/\/.+\n)?/, "")}`,
					},
					{
						start: references.start,
						/** @param text {string} */
						fn: text =>
						// eslint-disable-next-line indent
`${text.slice(0, references.start).replace(/(\s+|\/\/.+)$/, "")}
\t// vv Generated dependencies, do not modify vv
\t"references": [
${referencesEntries.map(refPath => `\t\t{ "path": ${JSON.stringify(relative(path, refPath))} },\n`).join("")}\t],
\t// ^^ Generated dependencies, do not modify ^^
${text.slice(references.end).replace(/^[,\s]*\n(?:\s+\/\/.+\n)?/, "")}`,
					},
				];
				slices.sort((left, right) => right.start - left.start);
				const modifiedSourceText = slices.reduce((text, { fn }) => fn(text), sourceText);
				if (modifiedSourceText !== sourceText) {
					await fs.writeFile(`${path}/tsconfig.json`, modifiedSourceText, "utf8");
				}
			}();
		} else if (dependencies.some(dependency => projectMap.has(dependency))) {
			console.warn(`⚠️ ${path} has reference dependencies but no "path" or "references" in tsconfig.json`);
		}
	}
}());
