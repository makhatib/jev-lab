"""Vendored from https://github.com/browser-use/jev-ultrafast at commit 1231850 (2026-09-18), MIT (see LICENSE).

Files kept unchanged: model.py, questions.py, browser.py, snapshot.js. Local adaptations live outside this
package: browser_harness/ (CDP transport stand-in -> ../cdp_client.py) and service.py (open_browser():
per-run browser context instead of Browser.__init__'s default-context tab; Claude layer; code guards).
"""
