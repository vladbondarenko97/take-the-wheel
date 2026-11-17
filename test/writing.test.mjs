// node --test test/   (no deps). Writing-only mode's code checks: word limit, word count, meta-line stripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordLimit, countWords, stripMeta } from '../runner/writing.mjs';

test('word limit is parsed from the task', () => {
  for (const [task, n] of [
    ['Write a report on the breach (300 words).', 300],
    ['Keep it under 250 words.', 250],
    ['max 500 words', 500],
    ['no more than 400 words, cite sources', 400],
    ['a 250-word summary', 250],
    ['Word limit: 300', 300],
    ['word count of 1,200', 1200],
    ['between 250 and 300 words? write 250-300 words', 300],
    ['Write 2 paragraphs about firewalls', null],
    ['Use 5 words or fewer for the title', null], // under 10: a phrase rule, not an essay limit
  ]) assert.equal(wordLimit(task), n, task);
});

test('words are counted like a person counts them', () => {
  assert.equal(countWords('Deploy a next-gen firewall (Palo Alto PA-440) now.'), 8);
  assert.equal(countWords('# Report\n\n- **Patch** systems\n- Train staff —'), 5);
  assert.equal(countWords('  '), 0);
});

test('a leading line about the model or the request is stripped, the deliverable is not', () => {
  assert.equal(stripMeta('Since you requested a text-only response and no browser takeover, here is the report.\n\nAlexander Rocco was breached.'), 'Alexander Rocco was breached.');
  assert.equal(stripMeta('Sure! Here you go.\nThe attackers entered via phishing.'), 'The attackers entered via phishing.');
  assert.equal(stripMeta("Here's the incident report:\n\n## Findings\nPhishing."), '## Findings\nPhishing.');
  assert.equal(stripMeta('I have identified three gaps.\nFirst, patching.'), 'I have identified three gaps.\nFirst, patching.');
  assert.equal(stripMeta('The breach began with a phishing email.'), 'The breach began with a phishing email.');
});
