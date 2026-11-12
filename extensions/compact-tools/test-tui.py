#!/usr/bin/env python3
"""Real Kitty/Xvfb acceptance tests for compact activity; no remote model calls."""
import importlib.util
import json
import os
import shutil
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("kitty_harness", HERE.parent / "kitty-clipboard/test-kitty.py")
kitty_harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kitty_harness)


class CompactTuiTests(unittest.TestCase):
    mode = os.environ.get("PI_COMPACT_TEST_TUI_MODE", "fullscreen")

    def setUp(self):
        self.env = kitty_harness.KittyEnvironment()
        self.addCleanup(self.env.close)
        self.env.env.pop("PI_COMPACT_TEST_EXPAND_KEY", None)
        self.env.env.pop("PI_COMPACT_TEST_LONG_REASONING", None)
        self.env.env.pop("PI_COMPACT_TEST_WAIT_FOR_PROVIDER", None)
        self.env.env.pop("PI_COMPACT_TEST_TOOL_ERROR", None)
        self.env.env.pop("PI_COMPACT_TEST_MARKDOWN_REASONING", None)
        self.env.env.pop("PI_COMPACT_TEST_OUTPUT_PAD", None)
        self.env.env.pop("PI_COMPACT_TEST_ACTIVITY_DISABLED", None)
        if "disabled" in self._testMethodName:
            self.env.env["PI_COMPACT_TEST_ACTIVITY_DISABLED"] = "1"
        self.padding = 0 if "padded" in self._testMethodName else 1
        self.env.env["PI_COMPACT_TEST_OUTPUT_PAD"] = str(self.padding)
        if "markdown" in self._testMethodName:
            self.env.env["PI_COMPACT_TEST_MARKDOWN_REASONING"] = "1"
        if "failed_tool" in self._testMethodName:
            self.env.env["PI_COMPACT_TEST_TOOL_ERROR"] = "1"
        if "waiting" in self._testMethodName:
            self.env.env["PI_COMPACT_TEST_WAIT_FOR_PROVIDER"] = "1"
        if "remapped" in self._testMethodName:
            self.env.env["PI_COMPACT_TEST_EXPAND_KEY"] = "alt+o"
        if "narrow" in self._testMethodName:
            self.env.env["PI_COMPACT_TEST_LONG_REASONING"] = "1"
        cli = Path(os.environ.get("PI_COMPACT_TEST_PI", shutil.which("pi"))).resolve()
        self.env.kitty(["--hold", shutil.which("python3"), str(HERE / "testing/run-pi.py"), str(self.env.root),
                        shutil.which("node"), str(cli), str(HERE / "index.ts"),
                        str(HERE.parent / "pty-sessions/index.ts"), str(HERE / "testing/scenario.ts"), self.mode])
        self.env.wait(lambda: self.env.result("state.json"), timeout=30)

    def send(self, text):
        self.env.remote("send-text", "--", text)
        self.env.key("Return")

    def screen(self):
        return self.env.screen()

    def release(self, name):
        (self.env.root / name).touch()

    def thinking(self):
        self.send("E2E user prompt.")
        self.env.wait(lambda: (state := self.env.result("phase.json")) and state["phase"] == "thinking")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())

    def tools(self):
        self.release("continue-thinking")
        self.env.wait(lambda: (state := self.env.result("phase.json")) and state["phase"] == "thinking-second")
        self.release("continue-tools")
        self.env.wait(lambda: self.env.result("started-alpha.json") and self.env.result("started-beta.json"))

    def finish(self):
        self.release("finish-alpha")
        self.release("finish-beta")
        self.env.wait(lambda: (state := self.env.result("phase.json")) and state["phase"] == "settled")
        self.env.wait(lambda: "E2E final response." in self.screen())
        if self.env.result("phase.json").get("mode") == "compact":
            self.env.wait(lambda: "e2e_work" not in self.screen())

    def mouse_row(self, label, ctrl=True):
        row = next(i for i, line in enumerate(self.screen().splitlines()) if label in line)
        button = 16 if ctrl else 0
        # Actual SGR packets enter the real Pi stdin parser, using coordinates
        # measured from the real Kitty screen; never call a widget directly.
        packet = f"\x1b[<{button};5;{row + 1}M\x1b[<{button};5;{row + 1}m"
        self.env.remote("send-text", "--bracketed-paste", "disable", "--", packet)

    def test_disabled_activity_keeps_inline_summaries_and_two_state_expansion(self):
        self.thinking()
        self.tools()
        self.env.wait(lambda: "e2e_work" in self.screen())
        self.assertIn("E2E inspecting the workspace", self.screen())
        self.assertNotIn("E2E detailed output alpha", self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" in self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" not in self.screen())
        self.assertIn("E2E inspecting the workspace", self.screen(), "Off must never cycle back to compact")
        self.finish()
        self.assertEqual(self.env.result("phase.json")["mode"], "inline")

    def test_process_timer_and_control_click_expansion_preserve_plain_selection(self):
        if self.mode != "fullscreen":
            self.skipTest("Regular mode leaves mouse input to the terminal; /fg remains available")
        script = self.env.root / "clickable.sh"
        script.write_text("printf 'E2E_CLICKABLE_OUTPUT\\n'; pi-process status 'E2E clickable running'; sleep 60\n")
        self.send(f"!bash {script}")
        self.env.wait(lambda: "E2E clickable running" in self.screen())
        self.env.remote("send-text", "--", "E2E_CLICK_DRAFT")
        self.env.wait(lambda: "E2E_CLICK_DRAFT" in self.screen())
        header = lambda: next(line for line in self.screen().splitlines() if "E2E clickable running" in line).strip()
        first = header()
        self.assertRegex(first, r"^pty-1 \d+:\d{2}(?::\d{2})? E2E clickable running$")
        self.assertNotIn(" · ", first)
        self.env.wait(lambda: header() != first, timeout=3)
        self.assertNotIn("E2E_CLICKABLE_OUTPUT", self.screen())
        self.mouse_row("E2E clickable running", ctrl=False)
        time.sleep(0.15)
        self.assertNotIn("E2E_CLICKABLE_OUTPUT", self.screen())
        self.mouse_row("E2E clickable running")
        self.env.wait(lambda: "E2E_CLICKABLE_OUTPUT" in self.screen())
        self.assertIn("E2E_CLICK_DRAFT", self.screen())
        self.mouse_row("E2E clickable running")
        self.env.wait(lambda: "E2E_CLICKABLE_OUTPUT" not in self.screen())
        self.assertIn("E2E_CLICK_DRAFT", self.screen())
        self.assertIsNone(self.env.result("requests.json"), "expanding output must not invoke a model")

    def test_control_click_tool_summary_expands_only_that_tool(self):
        if self.mode != "fullscreen":
            self.skipTest("Regular mode leaves mouse input to the terminal")
        self.thinking()
        self.tools()
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        self.mouse_row("e2e_work", ctrl=False)
        time.sleep(0.15)
        self.assertNotIn("E2E detailed output alpha", self.screen())
        self.mouse_row("e2e_work")
        self.env.wait(lambda: "E2E detailed output alpha" in self.screen())
        self.assertNotIn("E2E detailed output beta", self.screen())
        self.mouse_row("e2e_work")
        self.env.wait(lambda: "E2E detailed output alpha" not in self.screen())
        self.finish()

    def test_settings_switch_applies_live_and_survives_reload(self):
        self.thinking()
        self.tools()
        self.finish()
        self.send("/settings")
        self.env.wait(lambda: "Compact activity" in self.screen())
        self.env.remote("send-text", "--", "Compact activity")
        self.env.wait(lambda: "Theme" not in self.screen())
        self.env.key("Return")
        self.env.wait(lambda: "› Compact activity" in self.screen())
        self.env.key("Return")
        path = self.env.root / "agent/compact-tools.json"
        def disabled():
            try:
                return json.loads(path.read_text()).get("activityEnabled") is False
            except (FileNotFoundError, json.JSONDecodeError):
                return False
        self.env.wait(disabled)
        self.env.key("Escape")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" in self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" not in self.screen())
        self.assertIn("E2E inspecting the workspace", self.screen())
        self.send("/reload")
        self.env.wait(lambda: (state := self.env.result("state.json")) and state["reason"] == "reload", timeout=30)
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        self.assertTrue(disabled())

    def test_environment_drives_real_streaming_tools_and_preserves_history(self):
        # Baseline infrastructure check: must pass before implementing compact mode.
        self.thinking()
        self.tools()
        self.finish()
        screen = self.screen()
        self.assertIn("E2E user prompt.", screen)
        self.assertIn("E2E response before tools.", screen)
        self.assertIn("E2E final response.", screen)
        history = json.dumps(self.env.result("history.json"))
        self.assertIn("E2E inspecting the workspace", history)
        self.assertIn("E2E detailed output alpha", history)

    def test_compact_updates_in_place_and_ctrl_o_has_three_levels(self):
        self.thinking()
        self.release("continue-thinking")
        self.env.wait(lambda: "E2E preparing the changes" in self.screen())
        screen = self.screen()
        self.assertNotIn("E2E inspecting the workspace", screen, "old activity must not accumulate in the transcript")
        self.release("continue-tools")
        self.env.wait(lambda: self.env.result("started-alpha.json") and self.env.result("started-beta.json"))
        self.env.wait(lambda: "alpha" in self.screen() and "beta" in self.screen())
        screen = self.screen()
        self.assertNotIn("E2E preparing the changes", screen)
        self.assertNotIn("E2E detailed output alpha", screen)
        # One Ctrl-O restores reasoning and one-line tool summaries, not results.
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        self.assertNotIn("E2E detailed output alpha", self.screen())
        # Second Ctrl-O shows complete tool results.
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" in self.screen())
        self.assertIn("E2E more detail beta", self.screen())
        # Third Ctrl-O returns to compact without discarding any history.
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" not in self.screen())
        self.assertNotIn("E2E inspecting the workspace", self.screen())
        self.assertEqual(self.env.result("requests.json")["requests"], 1, "view changes must not make model requests")
        self.finish()
        screen = self.screen()
        self.assertNotIn("e2e_work", screen)
        self.assertNotIn("E2E inspecting", screen)
        self.assertIn("E2E response before tools.", screen)
        self.env.key("ctrl+o")
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" in self.screen())
        self.assertEqual(self.env.result("requests.json")["requests"], 2)

    def test_background_jobs_stack_above_prompt_and_stay_out_of_transcript(self):
        for name in ("builder", "tester"):
            script = self.env.root / f"{name}.sh"
            script.write_text(f"pi-process status 'E2E {name} running'; sleep 60\n")
            self.send(f"!bash {script}")
            self.env.wait(lambda: f"E2E {name} running" in self.screen())
        self.env.remote("send-text", "--", "E2E_DRAFT")
        self.env.wait(lambda: "E2E_DRAFT" in self.screen())
        screen = self.screen()
        # Background statuses must be distinct live rows, not terminal output previews.
        self.assertEqual(screen.count("E2E builder running"), 1)
        self.assertEqual(screen.count("E2E tester running"), 1)
        self.assertNotIn("PTY session pty-", screen)
        lines = screen.splitlines()
        prompt = next(i for i, line in enumerate(lines) if "E2E_DRAFT" in line)
        for name in ("builder", "tester"):
            row = next(i for i, line in enumerate(lines) if f"E2E {name} running" in line)
            self.assertGreaterEqual(row, prompt - 5, "activity belongs directly above the prompt, not in the log")
            self.assertLess(row, prompt)
            self.assertTrue(lines[row].startswith(" " * self.padding + "pty-"), lines[row])
            self.assertNotIn("●", lines[row])
            self.assertRegex(lines[row].strip(), r"^pty-\d+ \d+:\d{2}(?::\d{2})? E2E ")
            self.assertNotIn(" · ", lines[row])
        first = next(i for i, line in enumerate(lines) if "E2E builder running" in line)
        last = next(i for i, line in enumerate(lines) if "E2E tester running" in line)
        self.assertEqual(lines[first - 1].strip(), "", "activity block needs its margin above")
        self.assertEqual(lines[last + 1].strip(), "", "keep one blank row below activity even while idle")
        self.assertIn("─", lines[last + 2], "exactly one blank row belongs before the prompt border")
        self.env.key("ctrl+u")
        self.send("/stop pty-1")
        self.env.wait(lambda: "E2E builder running" not in self.screen())
        self.assertIn("E2E tester running", self.screen())

    def test_padded_background_rows_follow_normal_output_alignment(self):
        self.test_background_jobs_stack_above_prompt_and_stay_out_of_transcript()

    def test_markdown_reasoning_matches_output_alignment_and_prompt_spacing(self):
        self.thinking()
        self.env.remote("send-text", "--", "E2E_STYLE_DRAFT")
        self.env.wait(lambda: "E2E_STYLE_DRAFT" in self.screen())
        lines = self.screen().splitlines()
        row = next(i for i, line in enumerate(lines) if "E2E inspecting the workspace" in line)
        prompt = next(i for i, line in enumerate(lines) if "E2E_STYLE_DRAFT" in line)
        self.assertTrue(lines[row].startswith(" " * self.padding + "E2E inspecting the workspace"), lines[row])
        self.assertNotIn("**", lines[row])
        self.assertNotIn("`", lines[row])
        self.assertIn("formatting", lines[row])
        self.assertEqual(lines[row - 1].strip(), "", "margin must be above the activity block")
        self.assertEqual(row + 2, prompt - 1, "keep exactly one blank row above the prompt border")
        self.assertEqual(lines[row + 1].strip(), "", "spinner clearance must not depend on its animation frame")
        self.assertIn("Working", lines[prompt - 1], "keep the native Working indicator in the prompt border")
        self.assertIn("─", lines[prompt - 1])
        self.assertEqual(self.screen().count("Working"), 1)
        self.tools()
        self.finish()

    def test_padded_markdown_reasoning_uses_configured_output_padding(self):
        self.test_markdown_reasoning_matches_output_alignment_and_prompt_spacing()

    def test_notification_reports_are_hidden_but_can_be_expanded_later(self):
        script = self.env.root / "notifier.sh"
        script.write_text("pi-process status 'E2E notifier running'; pi-process notify 'E2E_NOTIFICATION_REPORT'; sleep 60\n")
        self.send(f"!bash {script}")
        self.env.wait(lambda: (state := self.env.result("phase.json")) and state["phase"] == "thinking")
        self.env.wait(lambda: "E2E notifier running" in self.screen())
        self.assertNotIn("E2E_NOTIFICATION_REPORT", self.screen())
        self.tools()
        self.finish()
        self.assertNotIn("E2E_NOTIFICATION_REPORT", self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E_NOTIFICATION_REPORT" in self.screen())
        self.env.key("ctrl+o")
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E_NOTIFICATION_REPORT" not in self.screen())
        self.assertIn("E2E_NOTIFICATION_REPORT", (self.env.root / "session.jsonl").read_text())

    def test_narrow_resize_keeps_activity_one_line_and_preserves_unicode_draft(self):
        self.thinking()
        self.env.remote("send-text", "--", "保持 draft🙂")
        self.env.wait(lambda: "保持 draft🙂" in self.screen())
        self.env.remote("resize-os-window", "--action", "resize", "--unit", "cells", "--width", "44", "--height", "20")
        self.env.wait(lambda: "保持 draft🙂" in self.screen())
        screen = self.screen()
        self.assertIn("E2E inspecting the workspace", screen)
        self.assertLessEqual(sum("界" in line for line in screen.splitlines()), 1,
                             "one activity must never wrap into several status rows")
        self.env.remote("resize-os-window", "--action", "resize", "--unit", "cells", "--width", "100", "--height", "44")
        self.env.wait(lambda: "保持 draft🙂" in self.screen())
        self.env.key("ctrl+o")
        self.env.key("ctrl+o")
        self.env.key("ctrl+o")
        self.env.wait(lambda: "保持 draft🙂" in self.screen())
        self.assertEqual(self.screen().count("E2E inspecting the workspace"), 1)

    def test_abort_clears_running_activity_and_preserves_the_prompt(self):
        self.thinking()
        self.tools()
        self.env.wait(lambda: "alpha" in self.screen() and "beta" in self.screen())
        self.env.remote("send-text", "--", "E2E_ABORT_DRAFT")
        self.env.key("Escape")
        self.env.wait(lambda: (state := self.env.result("phase.json")) and state["phase"] == "settled")
        self.env.wait(lambda: "e2e_work" not in self.screen())
        self.assertIn("E2E_ABORT_DRAFT", self.screen())
        self.assertNotIn("E2E inspecting the workspace", self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())

    def test_failed_tool_details_remain_hidden_until_full_expansion(self):
        self.thinking()
        self.tools()
        self.finish()
        self.assertNotIn("E2E_HIDDEN_FAILURE_DETAILS", self.screen(), "failed tool bodies are still tool output")
        self.assertIn("E2E_HIDDEN_FAILURE_DETAILS", (self.env.root / "session.jsonl").read_text())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "e2e_work" in self.screen())
        self.assertNotIn("E2E_HIDDEN_FAILURE_DETAILS", self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E_HIDDEN_FAILURE_DETAILS" in self.screen())
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E_HIDDEN_FAILURE_DETAILS" not in self.screen())
        self.assertIn("E2E final response.", self.screen())

    def test_thinking_preference_does_not_leak_reasoning_into_compact_history(self):
        self.thinking()
        self.release("continue-thinking")
        self.env.wait(lambda: "E2E preparing the changes" in self.screen())
        self.env.key("ctrl+t")
        self.env.key("ctrl+t")
        time.sleep(0.15)
        self.assertNotIn("E2E inspecting the workspace", self.screen())
        self.assertEqual(self.screen().count("E2E preparing the changes"), 1)
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        self.release("continue-tools")
        self.env.wait(lambda: self.env.result("started-alpha.json") and self.env.result("started-beta.json"))
        self.finish()

    def test_waiting_for_first_provider_event_still_shows_live_activity(self):
        self.send("E2E user prompt.")
        self.env.wait(lambda: (state := self.env.result("phase.json")) and state["phase"] == "waiting")
        self.env.remote("send-text", "--", "E2E_WAIT_DRAFT")
        self.env.wait(lambda: "Working" in self.screen() and "E2E_WAIT_DRAFT" in self.screen())
        lines = self.screen().splitlines()
        status = next(i for i, line in enumerate(lines) if "Working" in line)
        draft = next(i for i, line in enumerate(lines) if "E2E_WAIT_DRAFT" in line)
        self.assertEqual(status, draft - 1, "Working belongs inside the native prompt border")
        self.assertIn("─", lines[status])
        self.assertEqual(self.screen().count("Working"), 1)
        self.release("begin-thinking")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        lines = self.screen().splitlines()
        draft = next(i for i, line in enumerate(lines) if "E2E_WAIT_DRAFT" in line)
        self.assertIn("Working", lines[draft - 1], "reasoning must not replace the native Working indicator")
        self.assertEqual(self.screen().count("Working"), 1)
        self.tools()
        self.finish()
        self.assertIn("E2E_WAIT_DRAFT", self.screen())

    def test_remapped_expansion_key_keeps_the_three_level_cycle(self):
        self.thinking()
        self.tools()
        self.env.wait(lambda: "alpha" in self.screen() and "beta" in self.screen())
        self.env.key("ctrl+o")
        time.sleep(0.15)
        self.assertNotIn("E2E inspecting the workspace", self.screen())
        self.env.key("alt+o")
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        self.assertNotIn("E2E detailed output alpha", self.screen())
        self.env.key("alt+o")
        self.env.wait(lambda: "E2E detailed output alpha" in self.screen())
        self.env.key("alt+o")
        self.env.wait(lambda: "E2E inspecting the workspace" not in self.screen())
        self.finish()

    def test_focused_dialog_keeps_native_expansion_and_cancel_behavior(self):
        self.thinking()
        self.tools()
        self.finish()
        self.send("/e2e-dialog")
        self.env.wait(lambda: "E2E focused dialog" in self.screen())
        self.env.key("ctrl+o")
        self.assertIn("E2E focused dialog", self.screen(), "expansion must not dismiss or replace the focused dialog")
        self.env.key("Escape")
        self.env.wait(lambda: "E2E focused dialog" not in self.screen())
        self.env.wait(lambda: "E2E inspecting the workspace" in self.screen())
        self.assertIn("E2E final response.", self.screen())

    def test_reload_restores_history_without_reintroducing_activity_rows(self):
        self.thinking()
        self.tools()
        self.finish()
        self.send("/reload")
        self.env.wait(lambda: (state := self.env.result("state.json")) and state["reason"] == "reload", timeout=30)
        self.env.wait(lambda: "E2E final response." in self.screen())
        self.assertNotIn("E2E inspecting the workspace", self.screen())
        self.assertNotIn("e2e_work", self.screen())
        self.env.key("ctrl+o")
        self.env.key("ctrl+o")
        self.env.wait(lambda: "E2E detailed output alpha" in self.screen())
        session = (self.env.root / "session.jsonl").read_text()
        self.assertIn("E2E preparing the changes", session)
        self.assertIn("E2E detailed output beta", session)


if __name__ == "__main__":
    unittest.main(verbosity=2)
