/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';

export function run(version: string | undefined) {
  const dir = tmp.dirSync().name;
  const location = `${__dirname}/bundle-definitions`;
  const bundles = fs.readdirSync(location);
  const results = [];
  for (const bundle of bundles) {
    const product = path.basename(bundle, '.json');
    const output = `${dir}/${product}.analysis.json`;
    const cli = `${__dirname}/cli.ts`
    if (version) {
      overwriteVersion(location, bundle, dir, version);
      execSync(
        `npx ts-node-script ${cli} bundle -i ${dir}/${bundle} -o ${output}`
      );
    } else {
      execSync(
        `npx ts-node-script ${cli} bundle -i ${dir}/${bundle} -m local -o ${output}`
      );
    }
    results.push(...parseAnalysisOutput(product, output));
  }
  console.log(results);
  return results;
}

function overwriteVersion(
  dir: string,
  bundle: string,
  temp: string,
  version: string
) {
  const definitions = JSON.parse(
    fs.readFileSync(`${dir}/${bundle}`, { encoding: 'utf-8' })
  );
  for (const definition of definitions) {
    const dependencies = definition.dependencies;
    for (const dependency of dependencies) {
      dependency.versionOrTag = version;
    }
  }
  fs.writeFileSync(`${temp}/${bundle}`, JSON.stringify(definitions, null, 2), {
    encoding: 'utf-8'
  });
}

function parseAnalysisOutput(product: string, output: string) {
  const analyses = JSON.parse(fs.readFileSync(output, { encoding: 'utf-8' }));
  const results = [];
  for (const analysis of analyses) {
    const sdk = `${product} (${analysis.name})`;
    const size = analysis.results[0].size;
    const type = 'bundle';
    results.push({ sdk, type, size });
  }
  return results;
}

run('9.1.3')
