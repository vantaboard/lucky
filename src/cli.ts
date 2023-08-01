import meow from 'meow';
import { readPackageUpSync } from 'read-pkg-up';
import { findUpSync } from 'find-up';
import { cosmiconfigSync } from 'cosmiconfig';
import { confirm } from '@inquirer/prompts';
import yaml from 'yaml';
import fs from 'fs';
import path from 'path';
import { select } from './select.js';
import { checkbox } from './checkbox.js';
import spawn from 'cross-spawn';

const pkgJson = readPackageUpSync({
    cwd: process.cwd(),
})?.packageJson;

if (spawn.sync('git', ['--version']).error) {
    throw new Error('Git is not installed');
}

const explorer = cosmiconfigSync('fflt');
const root = findUpSync('package.json');

interface FFLTConfig {
    commands: string[];
    scripts: string[];
    default_branch: string;
    ignore_pattern: string;
    include_cached: boolean;
    package_manager: string;
}

const defaultConfig = {
    commands: ['eslint', 'prettier', 'tsc'],
    scripts: ['lint', 'fix', 'format', 'tsc', 'typecheck'],
    default_branch: 'main',
    ignore_pattern: '/yarn.lock|package-lock.json/',
    include_cached: true,
    package_manager: 'npm',
} satisfies FFLTConfig;

const depCommandMap = {
    eslint: 'eslint',
    prettier: 'prettier',
    tsc: 'typescript',
};

function isArrayOfStrings(array: unknown) {
    return (
        Array.isArray(array) &&
        (!array.length ||
            (array.length > 0 && array.every(str => typeof str === 'string')))
    );
}

function notExistsOrStrArr(value: unknown) {
    return !value || (value && isArrayOfStrings(value));
}

const explorerResult = explorer.search();

function formatConfig(config: FFLTConfig) {
    const deps = [
        ...Object.keys(pkgJson?.dependencies || {}),
        ...Object.keys(pkgJson?.devDependencies || {}),
    ];

    config.commands = config.commands.filter(command =>
        deps.includes(depCommandMap[command as keyof typeof depCommandMap])
    );

    const scripts = [...Object.keys(pkgJson?.scripts || {})];

    config.scripts = scripts.filter(script =>
        config.scripts.some(s => script.startsWith(s))
    );

    return config;
}

function getConfig(config?: Record<string, unknown>): FFLTConfig {
    if (
        config &&
        Object.keys(config).some(key =>
            ['commands', 'scripts', 'default_branch'].includes(key)
        ) &&
        notExistsOrStrArr(config.commands) &&
        notExistsOrStrArr(config.scripts)
    ) {
        return formatConfig(
            Object.entries(defaultConfig).reduce<FFLTConfig>(
                (acc, [key, value]) => ({
                    ...acc,
                    [key]: config[key] !== undefined ? config[key] : value,
                }),
                {} as FFLTConfig
            )
        );
    }

    return formatConfig(defaultConfig);
}

const config = getConfig(explorerResult?.config);

const cli = meow(
    `
	Usage
	  $ fflt init

	Options
	  --version, -v  Show version
`,
    {
        importMeta: import.meta,
        flags: {},
    }
);

const extensions = {
    js: '.js',
    mjs: '.mjs',
    cjs: '.cjs',
    json: '',
    yml: '.yml',
};

const stringifiers = {
    js: (config: FFLTConfig) =>
        `module.exports = ${JSON.stringify(config, null, 2)}`,
    mjs: (config: FFLTConfig) =>
        `export default ${JSON.stringify(config, null, 2)}`,
    cjs: (config: FFLTConfig) =>
        `module.exports = ${JSON.stringify(config, null, 2)}`,
    json: (config: FFLTConfig) => JSON.stringify(config, null, 2),
    yml: (config: FFLTConfig) => yaml.stringify(config),
};

function writeConfig(
    root: string,
    type: 'js' | 'mjs' | 'cjs' | 'json' | 'yml'
) {
    fs.writeFileSync(
        path.join(path.parse(root).dir, `.ffltrc${extensions[type]}`),
        stringifiers[type](config),
        'utf8'
    );
}

function getBranches() {
    const branches = spawn.sync('git', ['branch', '-a'], {
        encoding: 'utf8',
    }).stdout;

    const cleanBranches = branches.replace(
        /^[\\+\s\\*]\s(remotes\/.+\/)?/gm,
        ''
    );

    const uniqBranches = [...new Set(cleanBranches.split('\n'))].filter(
        branch => branch !== ''
    );
    const mainBranches = uniqBranches.filter(branch =>
        ['master', 'main', 'root', 'primary'].includes(branch)
    );
    const sortedBranches = uniqBranches
        .filter(
            branch => !['master', 'main', 'root', 'primary'].includes(branch)
        )
        .sort((a, b) => a.localeCompare(b));

    return [...mainBranches, ...sortedBranches];
}

async function handleInit() {
    if (!root) {
        throw new Error('Could not find root. Root must have a package.json.');
    }

    const confirmConfig =
        !explorerResult &&
        (await confirm({
            message: 'Do you want to create a config file?',
        }));

    const configFileType =
        confirmConfig &&
        (await select({
            message: 'Which config file do you want to create?',
            choices: [
                {
                    name: 'JSON',
                    value: 'json',
                    description: 'Create a JSON config file',
                },
                {
                    name: 'YAML',
                    value: 'yml',
                    description: 'Create a YAML config file',
                },
                {
                    name: 'JavaScript',
                    value: 'js',
                    description: 'Create a JavaScript config file',
                },
                {
                    name: 'JavaScript (Module)',
                    value: 'mjs',
                    description: 'Create a JavaScript config file',
                },
                {
                    name: 'JavaScript (Common)',
                    value: 'cjs',
                    description: 'Create a JavaScript config file',
                },
            ],
        }));

    const packageManager =
        confirmConfig &&
        (await select({
            message: 'Which package manager do you want to use?',
            choices: [
                {
                    name: 'npm',
                    value: 'npm',
                    description: 'Use npm',
                },
                {
                    name: 'yarn',
                    value: 'yarn',
                    description: 'Use yarn',
                },
                {
                    name: 'pnpm',
                    value: 'pnpm',
                    description: 'Use pnpm',
                },
            ],
        }));

    const defaultBranch =
        confirmConfig &&
        (await select({
            message: 'Which branch do you want to use as the default?',
            choices: getBranches().map(branch => ({
                name: branch,
                value: branch,
                description: `Use ${branch} as the default branch`,
            })),
        }));

    const includeCached = confirmConfig
        ? await confirm({
            message: 'Do you want to include staged files?',
        })
        : undefined;

    const scripts =
        confirmConfig &&
        (await checkbox({
            message: 'Which scripts do you want to run?',
            choices: Object.entries(pkgJson?.scripts || {}).map(
                ([name, script]) => ({
                    name,
                    value: name,
                    checked: config.scripts.includes(name),
                    description: script,
                })
            ),
        }));

    config.package_manager = packageManager || config.package_manager;
    config.default_branch = defaultBranch || config.default_branch;
    config.include_cached = includeCached ?? config.include_cached;
    config.scripts = scripts || config.scripts;

    switch (configFileType) {
        case 'json':
            writeConfig(root, 'json');
            break;
        case 'yml':
            writeConfig(root, 'yml');
            break;
        case 'js':
            writeConfig(root, 'js');
            break;
        case 'mjs':
            writeConfig(root, 'mjs');
            break;
        case 'cjs':
            writeConfig(root, 'cjs');
            break;
        default:
            break;
    }
}

const fftl = async (arg: string) => {
    if (!arg) {
        return;
    }

    if (arg === 'init') {
        await handleInit();
    }
};

void (async () => {
    await fftl(cli.input[0]);
})();
