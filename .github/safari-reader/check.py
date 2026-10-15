"""Assert which pages Safari offers Reader on, using Safari's own detection.

Safari decides whether Reader is available (and so whether "Use Reader
Automatically" can kick in on iOS) with an injected script embedded in the
OS. extract.py pulls that script out of the runner's macOS install at run
time; nothing from it is stored in this repository.

Usage: check.py <reader-script.js> <base-url> <path>=<yes|no> ...
"""
import json
import re
import sys
import pathlib

from selenium import webdriver
from selenium.webdriver.support.ui import WebDriverWait

script_path, base_url, *expectations = sys.argv[1:]
source = pathlib.Path(script_path).read_text(errors="replace")
# Safari evaluates the source with bare global assignments allowed; drop the
# strict-mode directive so those assignments behave the same in page scope.
source = re.sub(r"[\"']use strict[\"'];?", "", source)

# Safari's driver can hand control back before the new document has replaced
# the old one, and probing then reads the previous page or an empty body. Wait
# until the requested path is the loaded document before running the detector.
LOADED = r"""
return location.pathname === arguments[0] && document.readyState === 'complete'
  && !!document.querySelector('main');
"""

PROBE = r"""
const source = arguments[0];
try { (0, eval)(source); } catch (e) { return {error: 'load: ' + e.message}; }
if (typeof ReaderArticleFinder === 'undefined') return {error: 'ReaderArticleFinder missing'};
const finder = new ReaderArticleFinder(document);
try {
  const node = finder.articleNode();
  return {
    available: finder.isReaderModeAvailable(),
    articleNode: node ? node.tagName + '.' + String(node.className).slice(0, 40) + ' (' + (node.textContent || '').length + ' chars)' : null,
  };
} catch (e) { return {error: 'run: ' + e.message}; }
"""

driver = webdriver.Safari()
failures = []
try:
    for item in expectations:
        path, expected = item.split("=")
        driver.get(base_url.rstrip("/") + path)
        WebDriverWait(driver, 30).until(lambda d: d.execute_script(LOADED, path))
        result = driver.execute_script(PROBE, source)
        print(f"{path}: {json.dumps(result)} (expected available={expected})", flush=True)
        if "error" in result:
            failures.append(f"{path}: detector error {result['error']}")
        elif result["available"] != (expected == "yes"):
            failures.append(f"{path}: Reader available={result['available']}, expected {expected}")
finally:
    driver.quit()

if failures:
    print("\n".join(failures))
    sys.exit(1)
print("Safari Reader availability matches expectations.")
