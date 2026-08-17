# Grok

For Claude, see [Claude](./providers-claude.md). For Codex, see [Codex](./providers-codex.md).

## Where Grok Skills Come From

T3 Code asks the Grok CLI for the skills it would load in your workspace, and shows that list in
the composer's `$` picker.

This means the picker matches Grok's own discovery exactly: personal skills, project skills,
bundled skills, plugin skills, and any extra directories or overrides from your Grok
configuration all appear, with Grok's own de-duplication applied. Skills you have disabled in
your Grok configuration, or that are not user-invocable, stay out of the picker — the same way
Grok hides them from its own slash menu.
