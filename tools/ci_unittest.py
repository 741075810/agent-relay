"""Run unittest modules and put every failure into a check-run annotation.

Why this exists: job logs need `actions: read`, which the stored credential does not have,
so a red run whose only public trace is "Process completed with exit code 1" cannot be
diagnosed without a token. `tools/release_gate.py --github` solved that for the gate; this
is the same treatment for suites that are not the gate -- the cross-platform tooling job
runs four of them directly.

Each failing test becomes one `::error title=<module>.<class>.<test>::<the line that
explains it>` annotation, scrubbed of absolute paths and anything that looks like an
account segment. The full output still goes to stdout, so nothing is lost, and the
annotation is the part that can be read without permission.
"""
import argparse
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# Both, because this file lives in `tools/` while the suites live in the repository root.
# Running a script by path puts its own directory on `sys.path`, not the current one.
for candidate in (HERE, os.path.dirname(HERE)):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

import importlib.util


def load_gate():
    spec = importlib.util.spec_from_file_location(
        'release_gate', os.path.join(HERE, 'release_gate.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AnnotatingResult(unittest.TextTestResult):
    """A normal verbose result that also emits one annotation per failure."""

    def __init__(self, *args, **kwargs):
        super(AnnotatingResult, self).__init__(*args, **kwargs)
        self.gate = load_gate()

    def _emit(self, test, err):
        trace = self._exc_info_to_string(err, test)
        part = {'output': trace}
        lines = self.gate.detail_lines(part, limit=3)
        reason = lines[0] if lines else 'failed'
        title = '%s.%s' % (test.__class__.__module__,
                           getattr(test, '_testMethodName', test.__class__.__name__))
        print('::error title=%s::%s' % (self.gate.github_escape(title),
                                        self.gate.github_escape(reason)))

    def addError(self, test, err):
        super(AnnotatingResult, self).addError(test, err)
        self._emit(test, err)

    def addFailure(self, test, err):
        super(AnnotatingResult, self).addFailure(test, err)
        self._emit(test, err)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('modules', nargs='+')
    args = parser.parse_args(argv)

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for name in args.modules:
        suite.addTests(loader.loadTestsFromName(name))
    runner = unittest.TextTestRunner(verbosity=2, resultclass=AnnotatingResult)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
