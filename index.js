#! /usr/bin/env node
const process = require("process");
const fs = require("fs");
const path = require("path");

const semver = require("semver");
const Config = require("truffle-config");
const Resolver = require("truffle-resolver");
const tsort = require("tsort");
const SolidityParser = require("solidity-parser");

const PRAGAMA_SOLIDITY_VERSION_REGEX = /^\s*pragma\ssolidity\s+(.*?)\s*;/;
const SUPPORTED_VERSION_DECLARATION_REGEX = /^\^?\d+(\.\d+){1,2}$/;
const IMPORT_SOLIDITY_REGEX = /^.*import.*$/mg;

function unique(array) {
  return [...new Set(array)];
}

function resolve(importPath) {
  const config = Config.default();
  const resolver = new Resolver(config);

  return new Promise((resolve, reject) => {
    resolver.resolve(importPath, (err, fileContents, filePath) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({ fileContents, filePath });
    });
  });
}

function getDependencies(filePath, fileContents) {
  const dependencies = [];

  let imports;
  try {
    imports = SolidityParser.parse(fileContents, "imports");
  } catch (error) {
    throw new Error(
      "Could not parse " + filePath + " for extracting its imports."
    );
  }

  for (let dependency of imports) {
    if (dependency.startsWith("./") || dependency.startsWith("../")) {
      dependency =
        filePath.substring(0, filePath.lastIndexOf("/") + 1) + dependency;
      dependency = path.normalize(dependency);
    }

    dependencies.push(dependency);
  }

  return dependencies;
}

async function dependenciesDfs(graph, visitedFiles, filePath) {
  visitedFiles.push(filePath);

  const resolved = await resolve(filePath);

  const dependencies = getDependencies(
    resolved.filePath,
    resolved.fileContents
  );

  for (let dependency of dependencies) {
    graph.add(dependency, filePath);

    const resolvedDependency = await resolve(dependency);

    if (!visitedFiles.includes(dependency)) {
      await dependenciesDfs(graph, visitedFiles, dependency);
    }
  }
}

async function getSortedFilePaths(entryPoint) {
  const graph = tsort();
  const visitedFiles = [];

    await dependenciesDfs(graph, visitedFiles, entryPoint);

  const topologicalSortedFiles = graph.sort();
  // If an enrty has no dependency it won't be included in the graph, so we
  // add them and then dedup the array
  const withEntries = topologicalSortedFiles.concat(entryPoint);

  const files = unique(withEntries);

  return files;
}


async function getFileCompilerVersionDeclaration(filePath) {
  const resolved = await resolve(filePath);

  const matched = resolved.fileContents.match(PRAGAMA_SOLIDITY_VERSION_REGEX);

  if (matched === null) {
    return undefined;
  }

  const version = matched[1];

  if (!SUPPORTED_VERSION_DECLARATION_REGEX.test(version)) {
    throw new Error(
      "Unsupported compiler version declaration in  " +
        filePath +
        ": " +
        version +
        ". Only pinned or ^ versions are supported."
    );
  }

  return version;
}

async function normalizeCompilerVersionDeclarations(files) {
  let pinnedVersion;
  let pinnedVersionFile;

  let maxCaretVersion;
  let maxCaretVersionFile;

  for (const file of files) {
    const version = await getFileCompilerVersionDeclaration(file);

    if (version === undefined) {
      continue;
    }

    if (version.startsWith("^")) {
      if (maxCaretVersion == undefined) {
        maxCaretVersion = version;
        maxCaretVersionFile = file;
      } else {
        if (semver.gt(version.substr(1), maxCaretVersion.substr(1))) {
          maxCaretVersion = version;
          maxCaretVersionFile = file;
        }
      }
    } else {
      if (pinnedVersion === undefined) {
        pinnedVersion = version;
        pinnedVersionFile = file;
      } else if (pinnedVersion !== version) {
        throw new Error(
          "Differernt pinned compiler versions in " +
            pinnedVersionFile +
            " and " +
            file
        );
      }
    }

    if (maxCaretVersion !== undefined && pinnedVersion !== undefined) {
      if (!semver.satisfies(pinnedVersion, maxCaretVersion)) {
        throw new Error(
          "Incompatible compiler version declarations in " +
            maxCaretVersionFile +
            " and " +
            pinnedVersionFile
        );
      }
    }
  }

  if (pinnedVersion !== undefined) {
    return pinnedVersion;
  }

  return maxCaretVersion;
}
async function printFileWithoutPragma(filePath,outputPath) {

  const resolved = await resolve(filePath);
  const output = resolved.fileContents.replace(
    PRAGAMA_SOLIDITY_VERSION_REGEX,
    ""
  ).replace(IMPORT_SOLIDITY_REGEX,"");
  fs.appendFileSync(outputPath,"\n\n"+output.trim())
}

async function printContactenation(files,outputPath) {
  const version = await normalizeCompilerVersionDeclarations(files);
  const outputDir = path.parse(outputPath).dir;
  if (version) {
    if (!fs.existsSync(outputDir)) { fs.mkdirSync(outputDir); }
    fs.writeFileSync(outputPath,"pragma solidity " + version + ";");
  }

  for (const file of files) {
    await printFileWithoutPragma(file,outputPath);
  }
}

async function main(files) {
  if(!files[0] || !files[1]) throw new Error("You must specify both file path and output directory");
  const name = path.parse(files[0]).base;
  const outputDirPath = path.resolve(files[1]);
  const outputPath = path.join(outputDirPath,name);
  if (files.length == 0) {
    console.error("Usage: truffle-flattener <files>");
  }

  try {
    const sortedFiles = await getSortedFilePaths(files[0]);
    await printContactenation(sortedFiles,outputPath);
  } catch (error) {
    console.log(error);
  }
}

main(process.argv.slice(2));

//TODO: Fix tool to only take one file
//TODO: clean code
