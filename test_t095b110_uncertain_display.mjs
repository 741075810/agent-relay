// T095B110: how the popup words a queue error it cannot fully vouch for.
//
// The host can refuse a write it has already published (`error.committed: true`), and the
// extension now keeps that flag (`PortError.committed` -> `lastErrorCommitted`). Until this
// suite existed, nothing consumed it: `popup.js` rendered `lastError` in red and said nothing
// about the event having landed, so "written, but its survival across a power cut is unknown"
// looked exactly like "nothing happened". The opposite error is just as bad -- a host that
// never sends the field proves nothing, so its silence must not be read as "definitely not
// committed".
//
// The three states this module has to keep apart:
//
//   committed === true      the write is on disk, durability unconfirmed
//   committed === false     the host says the write did not land
//   committed === undefined the host does not report it (every host before T108)
//
// This suite runs the same module the popup loads, so it tests the shipped decision rather
// than a copy of it.
//
// The module has no exports on purpose: popup.js is a classic script (T063 pins that) and gets
// the function through one global. Importing the file here executes exactly that code.
await import('./extension/lib/queue_error_view.js');
const describeQueueError = globalThis.describeQueueError;

let pass = 0;
let fail = 0;
function check(ok, label) {
  if (ok) {
    pass += 1;
    console.log('  PASS  ' + label);
  } else {
    fail += 1;
    console.log('  FAIL  ' + label);
  }
}

const TEXT = 'internal: the queue file was replaced and its content is what a reader now sees';

{
  const view = describeQueueError({ lastError: TEXT, lastErrorCommitted: true });
  check(view.tone === 'warn', 'a committed failure is not painted as a plain failure');
  check(view.text.includes('已写入'), 'it says the write landed: ' + view.text.slice(0, 24));
  check(view.text.includes('耐久性'), 'it says durability is unconfirmed');
  check(view.text.includes('不要'), 'it tells the operator not to treat it as unwritten');
  check(view.text.includes(TEXT), 'the host wording is kept verbatim for diagnosis');
}

{
  const view = describeQueueError({ lastError: TEXT, lastErrorCommitted: false });
  check(view.tone === 'bad', 'a refusal without a commit claim stays a failure');
  check(!view.text.includes('已写入'), 'it does not claim the write landed');
  check(!view.text.includes('绝未提交'), 'it does not claim the opposite either');
}

{
  const view = describeQueueError({ lastError: TEXT });
  check(view.tone === 'bad', 'a host that omits the field still shows a failure');
  check(view.text.includes('旧版 Host') || view.text.includes('未获得'),
        'silence is reported as "no evidence", not as "not committed": '
        + view.text.slice(0, 30));
  check(!view.text.includes('绝未提交'), 'missing field is not read as a definite refusal');
}

{
  const view = describeQueueError({ lastError: null, lastErrorCommitted: false });
  check(view.tone === 'ok' && view.text === '—', 'a clean poll shows the neutral placeholder');
  const stale = describeQueueError({ lastError: null, lastErrorCommitted: true });
  check(stale.tone === 'ok',
        'a committed flag left over from an old error does not colour a clean state');
  check(stale.text === '—', 'the stale uncertainty is not shown after the queue converged');
}

{
  // The popup must actually consume the module -- a decision nobody calls is decoration.
  // Read as text because popup.js runs against a real DOM; the wiring is what matters here.
  const { readFileSync } = await import('node:fs');
  const popup = readFileSync(new URL('./extension/popup.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./extension/popup.html', import.meta.url), 'utf8');
  check(!/^\s*import\s/m.test(popup),
        'popup.js is still a classic script (T063 pins that)');
  check(popup.includes('describeQueueError('), 'popup.js calls the shared decision');
  const libAt = html.indexOf('src="lib/queue_error_view.js"');
  const popupAt = html.indexOf('src="popup.js"');
  check(libAt >= 0 && popupAt >= 0 && libAt < popupAt,
        'popup.html loads the decision before popup.js, or the global does not exist yet');
}

console.log('');
console.log((fail === 0 ? 'OK ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
