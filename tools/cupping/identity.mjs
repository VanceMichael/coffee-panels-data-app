// 身份层：杯次（cup）→ 盲样（blind）→ 实货批（lot）。
// 同一盲样的多杯是重复杯，只增加观测数，绝不产生多个供货批。
// 复判 withdrawn 在 updated_day 当日起覆盖此前 valid（按 analysisDay 截止）。

export function resolveBlindKeys(blindRows, analysisDay) {
  const map = new Map();
  for (const row of blindRows) {
    if (!map.has(row.blind)) {
      map.set(row.blind, {
        blind: row.blind,
        lot: row.lot,
        reference: row.reference,
        state: null,
        updatedDay: null,
        history: [],
      });
    }
    const record = map.get(row.blind);
    record.history.push({ state: row.state, updatedDay: row.updated_day, source: row.__source });
    if (row.updated_day !== null && row.updated_day <= analysisDay) {
      // 同日或之后的 withdrawn 覆盖 valid；同盲样最新状态以最大 updated_day 为准。
      if (record.updatedDay === null || row.updated_day >= record.updatedDay) {
        record.updatedDay = row.updated_day;
        record.state = row.state;
      }
    } else if (record.state === null) {
      record.state = row.state;
      record.updatedDay = row.updated_day;
    }
  }
  return map;
}

export function buildPanels(cupRows) {
  const panels = new Map();
  for (const cup of cupRows) {
    if (!panels.has(cup.session)) {
      panels.set(cup.session, { panel: cup.session, judges: new Set(), versions: new Set(), cups: [] });
    }
    const panel = panels.get(cup.session);
    panel.judges.add(cup.judge);
    panel.versions.add(cup.score_version);
    panel.cups.push(cup.cup);
  }
  return panels;
}

export function buildCupRecords(cupRows, blindMap, config) {
  const records = [];
  for (const cup of cupRows) {
    const blind = blindMap.get(cup.blind);
    const missingMeasures = config.allMeasures.filter(measure => cup[measure] === null);
    let usability = 'usable';
    let unusableReason = null;
    if (!blind) {
      usability = 'unusable';
      unusableReason = 'BLIND_KEY_MISSING';
    } else if (blind.state === 'withdrawn') {
      usability = 'unusable';
      unusableReason = blind.lot ? 'KEY_WITHDRAWN' : 'REFERENCE_WITHDRAWN';
    }
    records.push({
      cup: cup.cup,
      panel: cup.session,
      judge: cup.judge,
      blind: cup.blind,
      version: cup.score_version,
      observedDay: cup.observed_day,
      values: {
        aroma: cup.aroma,
        body: cup.body,
        defect: cup.defect,
      },
      missingMeasures,
      usability,
      unusableReason,
      source: cup.__source,
    });
  }
  return records;
}

export function buildLotIdentity(blindMap, cupRecords) {
  const lots = new Map();
  const samples = new Map();
  const ensureLot = lot => {
    if (!lots.has(lot)) {
      lots.set(lot, { lot, samples: [], cups: [], panels: new Set(), versions: new Set() });
    }
    return lots.get(lot);
  };
  for (const record of blindMap.values()) {
    if (!record.lot) continue;
    const lot = ensureLot(record.lot);
    if (!lot.samples.includes(record.blind)) lot.samples.push(record.blind);
    samples.set(record.blind, { blind: record.blind, lot: record.lot, state: record.state });
  }
  for (const cup of cupRecords) {
    const blind = blindMap.get(cup.blind);
    if (!blind || !blind.lot) continue;
    const lot = ensureLot(blind.lot);
    if (!lot.cups.includes(cup.cup)) lot.cups.push(cup.cup);
    lot.panels.add(cup.panel);
    lot.versions.add(cup.version);
  }
  for (const lot of lots.values()) {
    lot.panels = [...lot.panels].sort();
    lot.versions = [...lot.versions].sort();
  }
  return { lots, samples };
}

// 参照盲样索引：reference -> [{blind, panel, version, state, updatedDay}]
export function buildReferenceIndex(blindMap, cupRecords) {
  const index = new Map();
  for (const record of blindMap.values()) {
    if (!record.reference) continue;
    const panels = new Set();
    const versions = new Set();
    for (const cup of cupRecords.filter(c => c.blind === record.blind)) {
      panels.add(cup.panel);
      versions.add(cup.version);
    }
    if (!index.has(record.reference)) index.set(record.reference, []);
    index.get(record.reference).push({
      blind: record.blind,
      state: record.state,
      updatedDay: record.updatedDay,
      panels: [...panels].sort(),
      versions: [...versions].sort(),
    });
  }
  return index;
}
