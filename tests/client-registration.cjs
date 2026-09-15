const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const registrations = [];
vm.runInNewContext(fs.readFileSync(path.join(root, pkg.exports['./client']), 'utf8'), {
  window: { __ModuleLoader__: { load: entry => registrations.push(entry) } }
});
assert.equal(registrations.length, 1);
assert.equal(registrations[0].id, pkg.name, 'Client registration must match the package name requested by DSH');
assert.equal(typeof registrations[0].factory, 'function');
console.log('PASS client registration:', pkg.name);
