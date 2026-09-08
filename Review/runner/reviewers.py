"""physlibalpha-review reviewers — the agent drivers.

Each rubric is run by exactly one agent, read-only, in a clean room. "Clean room" means a
throwaway HOME seeded with only that agent's credential, so the review does not depend on the
operator's personal `CLAUDE.md` / `AGENTS.md`, skills, plugins, MCP servers, or settings. Two
people running the same rubric on the same PR should get reviews that differ by model, not by
local setup.

Read-only is enforced twice: by the tool allowlist passed to the agent, and by the fact that
nothing the agent can reach is the real repository — the workspace is a throwaway checkout.
"""

import json
import os
import platform
import shutil
import subprocess
import tempfile
import time

# provider -> (default model, auto-drawn?)
PROVIDERS = {
    "claude":   {"model": "claude-opus-5",        "auto": True},
    "codex":    {"model": "gpt-5.6-sol",          "auto": True},
    "sonnet":   {"model": "claude-sonnet-5",      "auto": False},
    "kiro":     {"model": "gpt-5.6-sol",          "auto": False},
    "deepseek": {"model": "deepseek/deepseek-v4-pro", "auto": False},
    "minimax":  {"model": "minimax/minimax-m3",   "auto": False},
    "grok":     {"model": "x-ai/grok-4",          "auto": False},
}

BINARIES = {
    "claude": "claude", "sonnet": "claude", "codex": "codex", "kiro": "kiro-cli",
    "deepseek": "pi", "minimax": "pi", "grok": "pi",
}

OPENROUTER = ("deepseek", "minimax", "grok")


class ReviewerError(RuntimeError):
    pass


def available(provider):
    return shutil.which(BINARIES.get(provider, "")) is not None


def auto_pool():
    """Providers drawn automatically when the caller does not name one."""
    return [p for p, v in PROVIDERS.items() if v["auto"] and available(p)]


def _clean_home(provider, auth, log):
    """A throwaway HOME seeded with only this provider's credential.

    On macOS a subscription login lives in the keychain rather than a credential file, so a
    throwaway HOME cannot carry it. We fall back to the real HOME there and say so; `--auth api`
    with a key gives a guaranteed clean room on every platform.
    """
    if auth == "api":
        home = tempfile.mkdtemp(prefix="physlibalpha-home-")
        return home, True, None
    if platform.system() == "Darwin" and provider in ("claude", "sonnet", "kiro"):
        return os.path.expanduser("~"), False, (
            "clean room not available on macOS for a keychain-backed subscription login; "
            "using the real HOME. Pass --auth api with a key for a guaranteed clean room.")
    home = tempfile.mkdtemp(prefix="physlibalpha-home-")
    real = os.path.expanduser("~")
    seeds = {"claude": [".claude/.credentials.json"], "sonnet": [".claude/.credentials.json"],
             "codex": [".codex/auth.json"], "kiro": [".aws/sso/cache", ".kiro"]}
    for rel in seeds.get(provider, []):
        src, dst = os.path.join(real, rel), os.path.join(home, rel)
        if os.path.exists(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, dst)
    return home, True, None


def _env(provider, home, auth):
    env = dict(os.environ)
    env["HOME"] = home
    # Never let the operator's project or user configuration reach the reviewer.
    for k in ("CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"):
        env.pop(k, None)
    if auth == "subscription":
        for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
            env.pop(k, None)
    if provider in OPENROUTER and not env.get("OPENROUTER_API_KEY"):
        raise ReviewerError(f"{provider} needs OPENROUTER_API_KEY")
    return env


def _cmd(provider, model, prompt_file, cwd, auth="subscription"):
    """The command line for one read-only review turn.

    For Claude the isolation is done with flags rather than only with the environment:
    `--setting-sources ""` loads no user/project/local settings (so no personal `CLAUDE.md`,
    skills, or plugins), and `--strict-mcp-config --mcp-config {}` admits no MCP server. Under
    `--auth api` we can go further and use `--bare`, which additionally skips hooks, auto-memory,
    and keychain reads — it requires an API key, so it is unavailable on a subscription login.
    """
    if provider in ("claude", "sonnet"):
        cmd = ["claude", "-p", "--output-format", "json",
               "--model", model,
               "--allowedTools", "Read,Grep,Glob",
               "--disallowedTools",
               "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task",
               "--permission-mode", "dontAsk",
               "--setting-sources", "",
               "--strict-mcp-config", "--mcp-config", '{"mcpServers": {}}',
               "--add-dir", str(cwd)]
        if auth == "api":
            cmd.insert(1, "--bare")
        return cmd
    if provider == "codex":
        return ["codex", "exec", "--sandbox", "read-only", "--model", model,
                "--skip-git-repo-check", "-C", str(cwd), "-"]
    if provider == "kiro":
        return ["kiro-cli", "chat", "--no-interactive", "--model", model, "--trust-tools",
                "fs_read"]
    if provider in OPENROUTER:
        return ["pi", "-m", model, "--tools", "read,grep,ls", "--no-write"]
    raise ReviewerError(f"unknown provider {provider}")


def _parse_usage(provider, raw):
    """Best-effort token usage. Kiro exposes no per-turn telemetry, so it stays None and the
    scoreboard records $0 rather than a fictional price."""
    if provider in ("claude", "sonnet"):
        try:
            d = json.loads(raw)
            u = d.get("usage") or {}
            return {"input": u.get("input_tokens"), "output": u.get("output_tokens"),
                    "cache_read": u.get("cache_read_input_tokens"),
                    "cache_write": u.get("cache_creation_input_tokens")}, d.get("result") or raw
        except Exception:
            return None, raw
    return None, raw


def run(provider, model, prompt, cwd, auth="subscription", timeout=1800, log=print):
    """One rubric turn. Returns a result dict; never raises for a model-side failure."""
    model = model or PROVIDERS[provider]["model"]
    if not available(provider):
        raise ReviewerError(f"{BINARIES[provider]} is not on PATH (needed for --reviewer {provider})")
    home, clean, note = _clean_home(provider, auth, log)
    if note:
        log(f"    note: {note}")
    env = _env(provider, home, auth)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(prompt)
        prompt_file = f.name
    cmd = _cmd(provider, model, prompt_file, cwd, auth=auth)
    started = time.time()
    try:
        p = subprocess.run(cmd, cwd=str(cwd), env=env, input=prompt, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        raw, err, rc = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired:
        raw, err, rc = "", f"timed out after {timeout}s", -1
    finally:
        os.unlink(prompt_file)
        if clean and home != os.path.expanduser("~"):
            shutil.rmtree(home, ignore_errors=True)
    usage, text = _parse_usage(provider, raw)
    return {"provider": provider, "model": model, "text": text, "raw": raw,
            "stderr": (err or "")[-2000:], "returncode": rc,
            "duration_s": round(time.time() - started, 1), "usage": usage,
            "clean_room": clean}
