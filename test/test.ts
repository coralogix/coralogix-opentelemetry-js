import { join } from 'node:path';
import { readdir } from 'node:fs/promises';

const testFiles: unknown[] = [];
const testDir = join(__dirname);

/*
    * This file is used to run all tests in the test directory.
    * kind of a hack since i couldn't make node tester run all tests through npm command
 */
(async () => {
    try {
        const files = await readdir(testDir, {recursive: true});

        files.forEach(function (file) {
            if (file.match(/\.spec\.ts$/)) {
                testFiles.push(import(join(testDir, file)));
            }
        });

        await Promise.all(testFiles);
    } catch (err) {
        console.log('Unable to scan directory: ' + err);
    }
})();