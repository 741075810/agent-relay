"""T354: the workflow must run T336 alone, in the log, without owning the verdict.

Run 42982214704 was red on Windows with `gate js suites: test_t336_productive_owner.mjs` and
nothing else: the aggregate step keeps one bounded snippet per failing suite, so the named
subtest, its `error:`/`expected:`/`actual:` and its stack only reach a job log -- and only if
something ran the suite in a way that prints them. This file pins the workflow step that does
that, and pins the two properties that keep it harmless: it cannot stop the gate from running,
and it cannot become a second verdict.

Parsed twice on purpose: PyYAML is not a declared dependency (requirements.txt carries
zstandard only), so the structural rules read the file as text and the YAML well-formedness
case skips where the module is absent instead of failing the suite for a missing dev package.
"""
import pathlib
import re
import unittest

WORKFLOW = pathlib.Path(__file__).resolve().parent / '.github' / 'workflows' / 'gate.yml'
STEP = 'T336 isolated, raw TAP'
SUITE = 'test_t336_productive_owner.mjs'


def text():
    return WORKFLOW.read_text(encoding='utf-8')


def steps(source):
    """[(name, block)] for each `- name:` step, in file order, indentation-agnostic.

    Comment lines are dropped from the blocks: the prose between two steps describes the
    next one, and letting it ride along makes an assertion about a step match its neighbour.
    """
    found = []
    current, body = None, []
    for line in source.splitlines():
        match = re.match(r'^\s*- name:\s*(.+?)\s*$', line)
        if match:
            if current is not None:
                found.append((current, '\n'.join(body)))
            current, body = match.group(1), []
        elif current is not None and not line.strip().startswith('#'):
            body.append(line)
    if current is not None:
        found.append((current, '\n'.join(body)))
    return found


class T336IsolatedStep(unittest.TestCase):
    """One suite, raw TAP in the log, and no authority over the gate's verdict."""

    @classmethod
    def setUpClass(cls):
        cls.source = text()
        cls.steps = steps(cls.source)
        cls.names = [name for name, _ in cls.steps]

    def block(self, name):
        for step, body in self.steps:
            if step == name:
                return body
        self.fail('%r is not a step in gate.yml (steps: %s)' % (name, self.names))

    def test_the_step_exists_exactly_once(self):
        self.assertEqual(self.names.count(STEP), 1, self.names)

    def test_it_runs_the_real_suite_through_the_test_runner(self):
        body = self.block(STEP)
        self.assertIn('node --test', body)
        self.assertIn(SUITE, body)
        # Node 24 defaults to the `spec` reporter, whose indented blocks and non-ASCII glyphs
        # are not what a job log needs; TAP carries `not ok N - <subtest>` plus the error
        # block. No other reporter is acceptable here, because the point is full detail.
        self.assertIn('--test-reporter=tap', body)

    def test_it_records_the_exit_code_and_the_failed_subtests(self):
        body = self.block(STEP)
        self.assertIn('T336_ISOLATED_EXIT', body)
        self.assertIn('T336_ISOLATED_FAILED_SUBTESTS', body)
        # node's TAP failure line is what names the subtest.
        self.assertIn('not ok', body)

    def test_it_prints_the_whole_output_rather_than_a_slice(self):
        body = self.block(STEP)
        self.assertRegex(body, r'\$lines \| ForEach-Object')
        for truncating in ('Select-Object -First', 'Select-Object -Last', 'Substring('):
            self.assertNotIn(truncating, body)

    def test_it_cannot_be_the_verdict(self):
        body = self.block(STEP)
        self.assertRegex(body, r'(?m)^\s*exit 0\s*$')
        # `exit $code` would abort the job before the release gate ever runs.
        self.assertNotRegex(body, r'(?m)^\s*exit \$code\s*$')
        self.assertNotIn('continue-on-error', body)

    def test_it_runs_before_the_release_gate(self):
        self.assertIn('release gate', self.names, self.names)
        self.assertLess(self.names.index(STEP), self.names.index('release gate'))

    def test_the_release_gate_keeps_its_command_and_its_authority(self):
        body = self.block('release gate')
        self.assertIn('python -B tools/release_gate.py --github --step-timeout 900', body)
        # No condition, no toleration: the gate still fails the job on its own.
        self.assertNotIn('continue-on-error', body)
        self.assertNotRegex(body, r'(?m)^\s*if:')

    def test_the_triggers_are_unchanged(self):
        for trigger in ('push:', 'pull_request:', 'workflow_dispatch:'):
            self.assertIn(trigger, self.source)
        self.assertNotRegex(self.source, r'(?m)^\s*if:\s*\$\{\{\s*github\.event_name.*\n\s*jobs:')

    def test_no_secret_is_referenced_by_the_diagnostic(self):
        for name, body in self.steps:
            self.assertNotIn('secrets.', body, name)

    @unittest.skipUnless(__import__('importlib').util.find_spec('yaml'), 'PyYAML is not installed')
    def test_the_file_is_valid_yaml_with_the_step_in_place(self):
        import yaml
        document = yaml.safe_load(self.source)
        jobs = document['jobs']
        gate = jobs['gate']['steps']
        names = [step.get('name') for step in gate]
        self.assertIn(STEP, names)
        self.assertLess(names.index(STEP), names.index('release gate'))
        chosen = gate[names.index(STEP)]
        self.assertEqual(chosen.get('shell'), 'pwsh')
        self.assertEqual(chosen.get('timeout-minutes'), 5)
        self.assertIn(SUITE, chosen['run'])
        self.assertIn('exit 0', chosen['run'])
        self.assertTrue(set(document[True]) >= {'push', 'pull_request', 'workflow_dispatch'})


if __name__ == '__main__':
    unittest.main()
