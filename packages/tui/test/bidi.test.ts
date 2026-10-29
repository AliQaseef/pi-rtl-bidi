import assert from "node:assert";
import { describe, it } from "node:test";
import bidiModule, { type Bidi } from "bidi-js";
import { alignRight, detectBaseDirection, hasStrongRtl, lineDirection, reorderLine } from "../src/bidi.ts";
import { visibleWidth } from "../src/utils.ts";

describe("strong script detection", () => {
	it("does not treat Latin text as RTL", () => {
		assert.equal(hasStrongRtl("hello world 123"), false);
		assert.equal(hasStrongRtl("مرحبا"), true);
		assert.equal(hasStrongRtl("שלום"), true);
		// Combining marks are not strong: a Latin string carrying an Arabic vowel
		// mark is still left-to-right.
		assert.equal(hasStrongRtl("a\u064F"), false);
	});

	it("uses the first strong character for the base direction", () => {
		assert.equal(detectBaseDirection("   مرحبا"), "rtl");
		assert.equal(detectBaseDirection("pi is مرحبا"), "ltr");
		assert.equal(detectBaseDirection("مرحبا", "ltr"), "ltr");
	});
});

describe("reorderLine", () => {
	it("leaves lines without RTL content untouched", () => {
		const plain = "hello world, run npm install --save typescript";
		assert.equal(reorderLine(plain), plain);
		const styled = "\x1b[31merror:\x1b[0m expected 1 but got 2";
		assert.equal(reorderLine(styled), styled);
	});

	it("reverses a pure Arabic paragraph", () => {
		assert.equal(reorderLine("مرحبا بالعالم"), "ملاعلاب ابحرم");
	});

	it("keeps embedded Latin words in left-to-right order", () => {
		assert.equal(reorderLine("ارسل إلى npm install ثم check"), "check مث npm install ىلإ لسرا");
		// The line opens with a path, but two of its three words are Arabic, so the
		// Arabic sentence is the paragraph and the path sits inside it.
		assert.equal(reorderLine("C:/Users/ali/file.ts هذا ملف"), "فلم اذه C:/Users/ali/file.ts");
		// Latin owns more words here, so the Arabic stays an embedded run.
		assert.equal(
			reorderLine("npm run build ثم check the test then build"),
			"npm run build مث check the test then build",
		);
	});

	it("keeps combining marks attached to their base character", () => {
		// A code-unit reversal would put the damma before the meem; a grapheme
		// reversal keeps the cluster together.
		const visual = reorderLine("مُرحبا");
		assert.equal(visual, "ابحرم\u064F");
		assert.ok(!visual.startsWith("\u064F"), "the mark must not end up alone at the line start");
	});

	it("mirrors brackets in right-to-left runs", () => {
		assert.equal(reorderLine("الفقرة (الثانية) تنتهي"), "يهتنت (ةيناثلا) ةرقفلا");
	});

	it("keeps edge whitespace where the layout put it", () => {
		// UAX #9 L1.4 keeps trailing whitespace at the end of the line. Leading
		// whitespace is anchored the same way because in a terminal the indent is
		// layout produced by the renderer, not content the reader is reading.
		assert.equal(reorderLine("مرحبا   "), "ابحرم   ");
		assert.equal(reorderLine("  مرحبا"), "  ابحرم");
	});

	it("does not move positional escape sequences", () => {
		const marker = "مرحبا\x1b_pi:c\x07";
		assert.equal(reorderLine(marker), marker);
		assert.equal(reorderLine("مرحبا\x1b[2H"), "مرحبا\x1b[2H");
	});

	it("keeps cell width identical after reordering", () => {
		const lines = ["مرحبا بالعالم", "السعر 100 دولار", "نص (داخل الأقواس)", "مُرحبا by pi", "日本語 مرحبا"];
		for (const line of lines) {
			assert.equal(visibleWidth(reorderLine(line)), visibleWidth(line), line);
		}
	});

	it("keeps styling with the grapheme it moves", () => {
		// The meem is the last logical character, so it becomes the first glyph of
		// the RTL run; the red that opened the span travels with it. The span is
		// closed with the code that clears only the foreground, never a full reset,
		// which would also wipe the background wrapped around the line.
		assert.equal(reorderLine("\x1b[31mمرحبا\x1b[0m tail"), "tail \x1b[31mابحرم");
		assert.ok(!reorderLine("\x1b[31mمرحبا\x1b[0m tail").includes("\x1b[0m"));
	});

	it("closes a style with the code that clears only that attribute", () => {
		// A full reset in the middle of the line would also wipe the background the
		// renderer wraps the line in, leaving the padding black.
		const line = "\x1b[38;5;250mمرحبا\x1b[39m tail";
		const reordered = reorderLine(line);
		assert.ok(!reordered.includes("\x1b[0m"), reordered);
		assert.equal(reordered.replace(/\x1b\[[0-9;]*m/g, ""), "tail ابحرم", reordered);
		assert.equal(visibleWidth(reordered), visibleWidth(line), reordered);
	});

	it("treats the empty parameter form ESC[m as a reset", () => {
		const reordered = reorderLine("\x1b[1mمرحبا\x1b[m tail");
		assert.equal(reordered.replace(/\x1b\[[0-9;]*m/g, ""), "tail ابحرم", reordered);
	});

	it("keeps hyperlinks attached to their text", () => {
		const line = "مرحبا \x1b]8;;https://pi.dev\x07الرابط\x1b]8;;\x07";
		const reordered = reorderLine(line);
		assert.ok(visibleWidth(reordered) === visibleWidth(line), reordered);
		assert.ok(reordered.includes("https://pi.dev"), reordered);
	});

	it("aligns RTL lines to the right edge", () => {
		const line = "مرحبا";
		assert.equal(visibleWidth(alignRight(line, 20)), 20);
		assert.ok(alignRight(line, 20).startsWith("   "));
	});

	it("aligns with the script that dominates the line", () => {
		// No RTL content means nothing to move: the line stays where it is.
		assert.equal(lineDirection("hello world 1234"), undefined);
		assert.equal(lineDirection("مرحبا بالعالم"), "rtl");
		assert.equal(lineDirection("npm install ثم build the package"), "ltr");
		assert.equal(lineDirection("مرحبا بالعالم (mixed 1234)"), "rtl");
		assert.equal(lineDirection("مرحبا"), "rtl");
		assert.equal(lineDirection("عربي text"), "rtl");
		// Equal counts fall back to the first strong character, the same rule UAX #9
		// uses for direction, so the script the line starts with wins.
		assert.equal(lineDirection("مرحبا hello"), "rtl");
		assert.equal(lineDirection("hello مرحبا"), "ltr");
	});

	it("reads a line by the script that owns it, not by its first character", () => {
		// A renderer can put a tool name, a code span or a marker at the front of a
		// line while the sentence behind it is Arabic. UAX #9 alone would order that
		// line by "ask", and the Arabic would read backwards.
		assert.equal(lineDirection("ask 3 questions (أي بريد يكتب في الـ commit؟)"), "rtl");
		assert.equal(lineDirection("commit الـ الذي يكتب في الريبو كثيرا", "ltr"), "ltr");
		// Escape codes are layout, not text: the letters in a style code do not
		// tip the balance towards Latin.
		assert.equal(lineDirection("\x1b[1mgit\x1b[0m حالة الريبو الحالية"), "rtl");
		assert.equal(lineDirection("git status"), undefined);
	});

	it("reorders by the same rule that aligns the line", () => {
		const line = "ask 3 questions (أي بريد يكتب في الـ commit؟)";
		assert.equal(reorderLine(line), reorderLine(line, "rtl"));
		assert.notEqual(reorderLine(line), reorderLine(line, "ltr"));
		// A Latin-dominant line keeps its LTR order even when it holds Arabic words.
		const mixed = "npm install ثم build the package";
		assert.equal(reorderLine(mixed), reorderLine(mixed, "ltr"));
	});

	// The reference is bidi-js's own UAX #9 reordering, run on the same graphemes.
	it("matches the bidi-js reference reordering", () => {
		// Same cast as in src/bidi.ts: bidi-js's default export is a factory.
		const reference = (bidiModule as unknown as () => Bidi)();
		const samples = [
			"مرحبا بالعالم",
			"الرقم 1234 هو الاصغر",
			"مرحبا — this line mixes Arabic and English, with numbers 1234.",
			"(قوس) مع [أقواس]",
			"عنصر أول",
			"أكتب بالعربية here",
			"هل支持 bidi؟ نعم 123",
		];
		// Combining marks are excluded: bidi-js reorders by code unit and detaches a
		// mark from its base letter, while a terminal needs the cluster to travel whole.
		for (const sample of samples) {
			const levels = reference.getEmbeddingLevels(sample, "auto");
			const expected = reference.getReorderedString(sample, levels);
			assert.equal(reorderLine(sample), expected, sample);
		}
	});
});
