import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePmcid,
  parseEuropePmcSearch,
  parsePubmedSummary,
} from '../../src/adapters/integration/opl-connect-reference-ncbi.ts';

test('NCBI reserve parser normalizes PubMed identifiers and metadata', () => {
  const record = parsePubmedSummary({
    result: {
      uids: ['20332509'],
      '20332509': {
        title: 'A reproducible reference',
        pubdate: '2026 Jun',
        fulljournalname: 'Journal of Tests',
        authors: [{ name: 'A. Researcher' }],
        articleids: [
          { idtype: 'doi', value: 'https://doi.org/10.1234/Example' },
          { idtype: 'pmc', value: '7654321' },
        ],
        pubtype: ['Journal Article'],
      },
    },
  }, '20332509');

  assert.equal(record?.normalized.doi, '10.1234/example');
  assert.equal(record?.normalized.pmid, '20332509');
  assert.equal(record?.normalized.pmcid, 'PMC7654321');
  assert.equal(record?.metadata.year, '2026');
  assert.equal(record?.fullTextAvailable, true);
});

test('NCBI reserve parser normalizes Europe PMC search results', () => {
  const record = parseEuropePmcSearch({
    resultList: {
      result: [{
        source: 'MED',
        id: '20332509',
        title: 'A reproducible reference',
        pubYear: '2026',
        journalTitle: 'Journal of Tests',
        authorList: { author: [{ fullName: 'A. Researcher' }] },
        inEPMC: 'Y',
      }],
    },
  });

  assert.equal(record?.normalized.pmid, '20332509');
  assert.equal(record?.metadata.title, 'A reproducible reference');
  assert.equal(record?.fullTextAvailable, true);
  assert.equal(normalizePmcid('7654321'), 'PMC7654321');
});
