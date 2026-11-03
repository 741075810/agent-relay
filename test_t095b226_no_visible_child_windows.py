"""T226: no child of this project may open a console window on the operator's desktop.

The relay sidecar runs with no console of its own and starts the Python host once per poll -- twenty seconds apart. Node's
`windowsHide` defaults to false, so each of those children was given a new console, which is a window: the flashing the
operator reported every twenty seconds. The Python supervisor had the same shape one layer down (T225) and was fixed with
`CREATE_NO_WINDOW`.

So the rule is mechanical and is asserted here rather than remembered: every production spawn in `tools/service` passes
`windowsHide: true`, and the supervisor starts console programs only through `run_hidden`.
"""

import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.join(HERE, 'tools', 'service')
SUPERVISOR = os.path.join(SERVICE, 'relay_supervisor.py')

SPAWN = re.compile(r'\bspawn\(')


def service_modules():
    return sorted(name for name in os.listdir(SERVICE) if name.endswith(('.mjs', '.js')))


class NoVisibleChildWindowsTest(unittest.TestCase):
    def test_every_production_spawn_hides_its_window(self):
        offenders = []
        for name in service_modules():
            path = os.path.join(SERVICE, name)
            with open(path, encoding='utf-8') as handle:
                text = handle.read()
            for match in SPAWN.finditer(text):
                # the call's own options object is the rest of the physical line, plus a look at the next few lines in
                # case the options were wrapped
                tail = text[match.end():match.end() + 400]
                line_of_call = text.count('\n', 0, match.start()) + 1
                if 'windowsHide' not in tail.split(');')[0]:
                    offenders.append('%s:%d' % (name, line_of_call))
        self.assertEqual(offenders, [], 'a spawn without windowsHide starts a visible console: %s' % offenders)

    def test_the_supervisor_only_starts_console_programs_through_run_hidden(self):
        import ast
        with open(SUPERVISOR, encoding='utf-8') as handle:
            tree = ast.parse(handle.read())
        allowed = {'run_hidden', 'spawn'}
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            for inner in ast.walk(node):
                if not isinstance(inner, ast.Call) or not isinstance(inner.func, ast.Attribute):
                    continue
                if isinstance(inner.func.value, ast.Name) and inner.func.value.id == 'subprocess' \
                        and inner.func.attr in ('run', 'Popen', 'call', 'check_output', 'check_call') \
                        and node.name not in allowed:
                    offenders.append(node.name)
        self.assertEqual(offenders, [], offenders)

    def test_the_hidden_helper_asks_windows_for_no_window(self):
        with open(SUPERVISOR, encoding='utf-8') as handle:
            text = handle.read()
        self.assertIn("kwargs['creationflags'] = CREATE_NO_WINDOW", text)
        self.assertIn("kwargs['startupinfo'] = hidden_startup()", text)
        self.assertIn('STARTF_USESHOWWINDOW', text)
        self.assertIn('SW_HIDE', text)
        # and it must be Windows-only: other platforms have no such flag
        self.assertIn("if os.name != 'nt':", text)


if __name__ == '__main__':
    unittest.main()
