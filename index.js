'use strict';

const fs = require('fs');
const path = require('path');
const { EOL } = require('os');

const CleanCSS = require('clean-css');
const program = require('commander');
const glob = require('glob');
const { version } = require('./package.json');

const COMPATIBILITY_PATTERN = /([\w.]+)=(\w+)/g;

const HELP = `
Examples:
  %> cleancss one.css
  %> cleancss -o one-min.css one.css
  %> cleancss -o merged-and-minified.css one.css two.css three.css
  %> cleancss one.css two.css three.css | gzip -9 -c > merged-minified-and-gzipped.css.gz

Formatting options:
  %> cleancss --format beautify one.css
  %> cleancss --format keep-breaks one.css
  %> cleancss --format "indentBy:1;indentWith:tab" one.css
  %> cleancss --format "breaks:afterBlockBegins=on;spaces:aroundSelectorRelation=on" one.css
  %> cleancss --format "breaks:afterBlockBegins=2;spaces:aroundSelectorRelation=on" one.css

Level 0 optimizations:
  %> cleancss -O0 one.css

Level 1 optimizations:
  %> cleancss -O1 one.css
  %> cleancss -O1 removeQuotes:off;roundingPrecision:4;specialComments:1 one.css
  %> cleancss -O1 all:off;specialComments:1 one.css

Level 2 optimizations:
  %> cleancss -O2 one.css
  %> cleancss -O2 mergeMedia:off;restructureRules:off;mergeSemantically:on;mergeIntoShorthands:off one.css
  %> cleancss -O2 all:off;removeDuplicateRules:on one.css`;

function cli(process, beforeMinifyCallback) {
  beforeMinifyCallback = beforeMinifyCallback || Function.prototype;

  // Specify commander options to parse command line params correctly
  program
    .usage('[options] <source-file ...>')
    .option('-b, --batch', 'If enabled, optimizes input files one by one instead of joining them together')
    .option('-c, --compatibility [ie7|ie8]', 'Force compatibility mode (see Readme for advanced examples)')
    .option('-d, --debug', 'Shows debug information (minification time & compression efficiency)')
    .option('-f, --format <options>', 'Controls output formatting, see examples below')
    .option('-h, --help', 'display this help')
    .option('-o, --output [output-file]', 'Use [output-file] as output instead of STDOUT')
    .option('-O <n> [optimizations]', 'Turn on level <n> optimizations; optionally accepts a list of fine-grained options, defaults to `1`, see examples below, IMPORTANT: the prefix is O (a capital o letter), NOT a 0 (zero, a number)', val => {
      return Math.abs(Number.parseInt(val, 10));
    })
    .version(version, '-v, --version')
    .option('--batch-suffix <suffix>', 'A suffix (without extension) appended to input file name when processing in batch mode (`-min` is the default)', '-min')
    .option('--inline [rules]', 'Enables inlining for listed sources (defaults to `local`)')
    .option('--inline-timeout [seconds]', 'Per connection timeout when fetching remote stylesheets (defaults to 5 seconds)', parseFloat)
    .option('--input-source-map [file]', 'Specifies the path of the input source map file')
    .option('--remove-inlined-files', 'Remove files inlined in <source-file ...> or via `@import` statements')
    .option('--source-map', 'Enables building input\'s source map')
    .option('--source-map-inline-sources', 'Enables inlining sources inside source maps')
    .option('--with-rebase', 'Enable URLs rebasing');

  program.addHelpText('after', HELP);

  program.parse(process.argv);
  const inputOptions = program.opts();

  // If no sensible data passed in just print help and exit
  if (program.args.length === 0) {
    const fromStdin = !process.env.__DIRECT__ && !process.stdin.isTTY;
    if (!fromStdin) {
      program.outputHelp();
      return;
    }
  }

  // Now coerce arguments into CleanCSS configuration...
  const options = {
    batch: inputOptions.batch,
    compatibility: inputOptions.compatibility,
    format: inputOptions.format,
    inline: typeof inputOptions.inline === 'string' ? inputOptions.inline : 'local',
    inlineTimeout: inputOptions.inlineTimeout * 1000,
    level: { 1: true },
    output: inputOptions.output,
    rebase: Boolean(inputOptions.withRebase),
    rebaseTo: inputOptions.withRebase && ('output' in inputOptions) && inputOptions.output.length > 0 ?
      path.dirname(path.resolve(inputOptions.output)) :
      (inputOptions.withRebase ? process.cwd() : undefined),
    sourceMap: inputOptions.sourceMap,
    sourceMapInlineSources: inputOptions.sourceMapInlineSources
  };

  if (program.rawArgs.includes('-O0')) {
    options.level[0] = true;
  }

  if (program.rawArgs.includes('-O1')) {
    options.level[1] = findArgumentTo('-O1', program.rawArgs, program.args);
  }

  if (program.rawArgs.includes('-O2')) {
    options.level[2] = findArgumentTo('-O2', program.rawArgs, program.args);
  }

  if (inputOptions.inputSourceMap && !options.sourceMap) {
    options.sourceMap = true;
  }

  if (options.sourceMap && !options.output) {
    outputFeedback(['Source maps will not be built because you have not specified an output file.'], true);
    options.sourceMap = false;
  }

  const configurations = {
    batchSuffix: inputOptions.batchSuffix,
    beforeMinifyCallback,
    debugMode: inputOptions.debug,
    removeInlinedFiles: inputOptions.removeInlinedFiles,
    inputSourceMap: inputOptions.inputSourceMap
  };

  // ... and do the magic!
  if (program.args.length > 0) {
    minify(process, options, configurations, expandGlobs(program.args));
  } else {
    const stdin = process.openStdin();
    stdin.setEncoding('utf-8');

    let data = '';

    stdin.on('data', chunk => {
      data += chunk;
    });

    stdin.on('end', () => {
      minify(process, options, configurations, data);
    });
  }
}

function findArgumentTo(option, rawArgs, args) {
  let value = true;
  const optionAt = rawArgs.indexOf(option);
  const nextOption = rawArgs[optionAt + 1];

  if (!nextOption) {
    return value;
  }

  const looksLikePath = nextOption.includes('.css') ||
    /\//.test(nextOption) ||
    /\\[^-]/.test(nextOption) ||
    /^https?:\/\//.test(nextOption);
  const asArgumentAt = args.indexOf(nextOption);

  if (!looksLikePath) {
    value = nextOption;
  }

  if (!looksLikePath && asArgumentAt > -1) {
    args.splice(asArgumentAt, 1);
  }

  return value;
}

function expandGlobs(paths) {
  const globPatterns = paths.filter(path => path[0] !== '!');
  const ignoredGlobPatterns = paths
    .filter(path => path[0] === '!')
    .map(path => path.slice(1));

  return globPatterns.reduce((accumulator, path) => {
    return accumulator.concat(glob.sync(path, {
      ignore: ignoredGlobPatterns,
      nodir: true,
      nonull: true
    }));
  }, []);
}

function minify(process, options, configurations, data) {
  const cleanCss = new CleanCSS(options);

  applyNonBooleanCompatibilityFlags(cleanCss, options.compatibility);
  configurations.beforeMinifyCallback(cleanCss);
  cleanCss.minify(data, getSourceMapContent(configurations.inputSourceMap), (errors, minified) => {
    if (options.batch && !('styles' in minified)) {
      for (const inputPath in minified) {
        if (Object.prototype.hasOwnProperty.call(minified, inputPath)) {
          processMinified(
            process,
            configurations,
            minified[inputPath],
            inputPath,
            toOutputPath(inputPath, configurations.batchSuffix)
          );
        }
      }
    } else {
      processMinified(process, configurations, minified, null, options.output);
    }
  });
}

function toOutputPath(inputPath, batchSuffix) {
  const extensionName = path.extname(inputPath);

  return inputPath.replace(new RegExp(extensionName + '$'), batchSuffix + extensionName);
}

function processMinified(process, configurations, minified, inputPath, outputPath) {
  if (configurations.debugMode) {
    if (inputPath) {
      console.log('File: %s', inputPath);
    }

    console.log('Original: %d bytes', minified.stats.originalSize);
    console.log('Minified: %d bytes', minified.stats.minifiedSize);
    console.log('Efficiency: %d%', Math.trunc(minified.stats.efficiency * 10000) / 100);
    console.log('Time spent: %dms', minified.stats.timeSpent);

    if (minified.inlinedStylesheets.length > 0) {
      console.log('Inlined stylesheets:');
      minified.inlinedStylesheets.forEach(uri => {
        console.log('- %s', uri);
      });
    }

    console.log('');
  }

  outputFeedback(minified.errors, true);
  outputFeedback(minified.warnings);

  if (minified.errors.length > 0) {
    process.exit(1);
  }

  if (configurations.removeInlinedFiles) {
    minified.inlinedStylesheets.forEach(file => fs.unlinkSync(file));
  }

  if (minified.sourceMap) {
    const mapOutputPath = outputPath + '.map';
    output(process, outputPath, minified.styles + EOL + '/*# sourceMappingURL=' + path.basename(mapOutputPath) + ' */');
    outputMap(mapOutputPath, minified.sourceMap);
  } else {
    output(process, outputPath, minified.styles);
  }
}

function applyNonBooleanCompatibilityFlags(cleanCss, compatibility) {
  if (!compatibility) {
    return;
  }

  let match;

  patternLoop:
  while ((match = COMPATIBILITY_PATTERN.exec(compatibility)) !== null) {
    let scope = cleanCss.options.compatibility;
    const parts = match[1].split('.');

    for (let i = 0, len = parts.length - 1; i < len; i++) {
      scope = scope[parts[i]];

      if (!scope) {
        continue patternLoop;
      }
    }

    scope[parts.pop()] = match[2];
  }
}

function outputFeedback(messages, isError) {
  const prefix = isError ? '\u001B[31mERROR\u001B[39m:' : 'WARNING:';

  messages.forEach(message => {
    console.error('%s %s', prefix, message);
  });
}

function getSourceMapContent(sourceMapPath) {
  if (!sourceMapPath || !fs.existsSync(sourceMapPath)) {
    return null;
  }

  let content = null;

  try {
    content = fs.readFileSync(sourceMapPath).toString();
  } catch {
    console.error('Failed to read the input source map file.');
  }

  return content;
}

function output(process, outputPath, minified) {
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, minified, 'utf8');
  } else {
    process.stdout.write(minified);
  }
}

function outputMap(mapOutputPath, sourceMap) {
  fs.writeFileSync(mapOutputPath, sourceMap.toString(), 'utf-8');
}

module.exports = cli;
