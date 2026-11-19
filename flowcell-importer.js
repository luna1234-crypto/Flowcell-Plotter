(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FlowcellImporter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SOURCE_QPX = "qpx600dp";
  const SOURCE_TEST_BRIDGE = "test-bridge";

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const input = String(text || "").replace(/^\uFEFF/, "");
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (quoted) {
        if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") {
        row.push(field.replace(/\r$/, ""));
        if (row.some(cell => cell.trim() !== "")) rows.push(row);
        row = [];
        field = "";
      } else field += char;
    }
    if (quoted) throw new Error("CSV contains an unclosed quoted field.");
    row.push(field.replace(/\r$/, ""));
    if (row.some(cell => cell.trim() !== "")) rows.push(row);
    return rows;
  }

  function normalizedHeader(value) {
    return String(value || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .replace(/^#\s*/, "")
      .toLowerCase()
      .replace(/[\[\{]/g, "(")
      .replace(/[\]\}]/g, ")")
      .replace(/[\s_\-]+/g, " ")
      .replace(/\s*\(\s*/g, " (")
      .replace(/\s*\)\s*/g, ")")
      .trim();
  }

  function unitMatches(header, unit) {
    const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:\\(|\\b|/)${escaped}(?:\\)|\\b)`, "i").test(header);
  }

  function classifyHeader(value) {
    const header = normalizedHeader(value);
    const isDensity = /density|cm\s*[-^]?\s*2|cm²|cm⁻²/.test(header);
    const elapsed = /\belapsed\b|\bduration\b/.test(header);
    const timeWord = /\btime\b|timestamp|datetime|date time/.test(header);
    const seconds = unitMatches(header, "s") || /\bsec(?:ond)?s?\b/.test(header);
    const timestamp = /timestamp|datetime|date time|time stamp/.test(header);
    const voltage = !isDensity && (/^volts?$/.test(header) || ((/\bvoltage\b|\bpotential\b/.test(header)) && unitMatches(header, "v")));
    const current = !isDensity && (/^(?:amps?|amperes?)$/.test(header) || (/\bcurrent\b/.test(header) && unitMatches(header, "a")));
    return { elapsedTime: elapsed && timeWord && seconds, timestamp, genericTime: timeWord && !elapsed && !timestamp, voltage, current };
  }

  function parseTimestamp(value) {
    const text = String(value || "").trim();
    let match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
    if (match) {
      const milliseconds = Math.round((Number(match[6]) % 1) * 1000);
      return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Math.floor(Number(match[6])), milliseconds).getTime();
    }
    match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})[ T](\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
    if (match) {
      const milliseconds = Math.round((Number(match[6]) % 1) * 1000);
      return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]), Math.floor(Number(match[6])), milliseconds).getTime();
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function uniqueIndex(indexes) { return indexes.length === 1 ? indexes[0] : null; }
  function isCommentRow(row) { return String(row?.[0] || "").trim().startsWith("#"); }

  function rowClassification(row) {
    const classified = row.map(classifyHeader);
    return {
      classified,
      elapsedCandidates: classified.flatMap((item, index) => item.elapsedTime ? [index] : []),
      timestampCandidates: classified.flatMap((item, index) => item.timestamp ? [index] : []),
      genericTimeCandidates: classified.flatMap((item, index) => item.genericTime ? [index] : []),
      voltageCandidates: classified.flatMap((item, index) => item.voltage ? [index] : []),
      currentCandidates: classified.flatMap((item, index) => item.current ? [index] : []),
    };
  }

  function findHeaderRow(rows) {
    let fallback = -1;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const candidates = rowClassification(row);
      const hasSignal = candidates.voltageCandidates.length || candidates.currentCandidates.length || candidates.elapsedCandidates.length || candidates.timestampCandidates.length;
      if (fallback < 0 && hasSignal) fallback = index;
      else if (fallback < 0 && !isCommentRow(row) && row.length >= 3) fallback = index;
      if (hasSignal && candidates.voltageCandidates.length && candidates.currentCandidates.length
        && (candidates.elapsedCandidates.length || candidates.timestampCandidates.length || candidates.genericTimeCandidates.length)) return index;
    }
    return fallback;
  }

  function precedingTime(valueIndex, timestampCandidates) {
    const preceding = timestampCandidates.filter(index => index < valueIndex);
    return preceding.length ? preceding[preceding.length - 1] : null;
  }

  function inspectCsv(text) {
    const allRows = parseCsv(text);
    const headerRowIndex = findHeaderRow(allRows);
    if (headerRowIndex < 0) {
      return {
        headers: [], rows: [], allRows, metadataRows: allRows.filter(isCommentRow), headerRowIndex: null,
        detectedSource: null, mapping: { time: null, voltage: null, currentTime: null, current: null },
        timeMode: null, confidence: "invalid", errors: ["CSV header row was not detected."], duplicateHeaders: [],
      };
    }

    const headers = allRows[headerRowIndex].map(header => header.trim());
    const dataRows = allRows.slice(headerRowIndex + 1).filter(row => !isCommentRow(row));
    const metadataRows = allRows.filter((row, index) => index !== headerRowIndex && isCommentRow(row)).map(row => row.slice());
    const normalized = headers.map(normalizedHeader);
    const candidates = rowClassification(headers);
    const voltage = uniqueIndex(candidates.voltageCandidates);
    const current = uniqueIndex(candidates.currentCandidates);
    let time = uniqueIndex(candidates.elapsedCandidates);
    let currentTime = time;
    let timeMode = time == null ? null : "elapsed";

    if (time == null && candidates.elapsedCandidates.length === 0 && candidates.timestampCandidates.length) {
      if (candidates.timestampCandidates.length === 1) {
        time = candidates.timestampCandidates[0];
        currentTime = time;
      } else if (candidates.timestampCandidates.length === 2 && voltage != null && current != null) {
        time = precedingTime(voltage, candidates.timestampCandidates);
        currentTime = precedingTime(current, candidates.timestampCandidates);
      }
      if (time != null && currentTime != null) timeMode = "timestamp";
    }

    if (time == null && candidates.elapsedCandidates.length === 0 && candidates.timestampCandidates.length === 0 && candidates.genericTimeCandidates.length === 1) {
      const candidate = candidates.genericTimeCandidates[0];
      const samples = dataRows.map(row => row[candidate]).filter(value => String(value || "").trim()).slice(0, 5);
      if (samples.length && samples.every(value => Number.isFinite(Number(value)))) {
        time = candidate; currentTime = candidate; timeMode = "elapsed";
      } else if (samples.length && samples.every(value => Number.isFinite(parseTimestamp(value)))) {
        time = candidate; currentTime = candidate; timeMode = "timestamp";
      }
    }

    const isTestBridgeShape = timeMode === "timestamp" || candidates.timestampCandidates.length > 0;
    const duplicateNames = [...new Set(normalized.filter((header, index) => header && normalized.indexOf(header) !== index))];
    const duplicateHeaders = duplicateNames.filter(name => {
      const indexes = normalized.flatMap((header, index) => header === name ? [index] : []);
      const expectedTimestampPair = isTestBridgeShape && indexes.length === 2
        && indexes.every(index => candidates.timestampCandidates.includes(index))
        && time != null && currentTime != null && time !== currentTime;
      return !expectedTimestampPair;
    });

    const errors = [];
    if (duplicateHeaders.length) errors.push(`Duplicated required header${duplicateHeaders.length === 1 ? "" : "s"}: ${duplicateHeaders.join(", ")}.`);
    if (candidates.elapsedCandidates.length > 1 || candidates.timestampCandidates.length > 2 || (time == null && candidates.genericTimeCandidates.length > 1)) errors.push("Time columns are ambiguous.");
    if (candidates.timestampCandidates.length === 2 && (time == null || currentTime == null || time === currentTime)) errors.push("Voltage and current timestamp columns are ambiguous.");
    if (candidates.voltageCandidates.length > 1) errors.push("Voltage column is ambiguous.");
    if (candidates.currentCandidates.length > 1) errors.push("Current column is ambiguous.");
    if (time == null && !errors.some(error => error.includes("Time column"))) errors.push("Voltage time column was not detected.");
    if (currentTime == null && !errors.some(error => error.includes("timestamp columns"))) errors.push("Current time column was not detected.");
    if (voltage == null && !errors.some(error => error.includes("Voltage column"))) errors.push("Voltage column was not detected.");
    if (current == null && !errors.some(error => error.includes("Current column"))) errors.push("Current (A) column was not detected.");

    const detectedSource = timeMode === "elapsed" && time != null && voltage != null && current != null
      ? SOURCE_QPX
      : timeMode === "timestamp" && time != null && currentTime != null && voltage != null && current != null
        ? SOURCE_TEST_BRIDGE
        : null;
    return {
      headers, rows: dataRows, allRows, metadataRows, headerRowIndex, detectedSource,
      mapping: { time, voltage, currentTime, current }, timeMode,
      confidence: detectedSource && errors.length === 0 ? "certain" : "uncertain",
      errors, candidates, duplicateHeaders,
    };
  }

  function assertColumnIndex(headers, index, role) {
    if (!Number.isInteger(index) || index < 0 || index >= headers.length) throw new Error(`${role} column is missing.`);
  }

  function assertAscending(series, label) {
    for (let index = 1; index < series.length; index += 1) {
      if (series[index].absoluteTimeMs < series[index - 1].absoluteTimeMs) throw new Error(`${label} timestamps must be in chronological order.`);
      if (series[index].absoluteTimeMs === series[index - 1].absoluteTimeMs) throw new Error(`${label} contains duplicated timestamps.`);
    }
  }

  function interpolateAt(series, targetTime) {
    if (!series.length || targetTime < series[0].absoluteTimeMs || targetTime > series[series.length - 1].absoluteTimeMs) return null;
    let low = 0;
    let high = series.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const point = series[middle];
      if (point.absoluteTimeMs === targetTime) return point.value;
      if (point.absoluteTimeMs < targetTime) low = middle + 1;
      else high = middle - 1;
    }
    const before = series[high];
    const after = series[low];
    if (!before || !after) return null;
    const ratio = (targetTime - before.absoluteTimeMs) / (after.absoluteTimeMs - before.absoluteTimeMs);
    return before.value + ratio * (after.value - before.value);
  }

  function currentMapping(inspection, mapping, electrodeAreaCm2) {
    const index = mapping.current;
    assertColumnIndex(inspection.headers, index, "Current (A)");
    const area = Number(electrodeAreaCm2);
    if (!Number.isFinite(area) || area <= 0) throw new Error("Electrode area must be a positive number.");
    return {
      index,
      role: "current",
      convert(value) {
        return { current: value, currentDensity: value / area };
      },
    };
  }

  function normalizeQpx(inspection, mapping, electrodeAreaCm2) {
    assertColumnIndex(inspection.headers, mapping.time, "Elapsed time");
    assertColumnIndex(inspection.headers, mapping.voltage, "Voltage");
    const currentMap = currentMapping(inspection, mapping, electrodeAreaCm2);
    if (new Set([mapping.time, mapping.voltage, currentMap.index]).size !== 3) throw new Error("Elapsed time, voltage, and current must map to three different columns.");
    const points = inspection.rows.map((row, rowIndex) => {
      const displayRow = inspection.headerRowIndex + rowIndex + 2;
      const timeText = String(row[mapping.time] ?? "").trim();
      const voltageText = String(row[mapping.voltage] ?? "").trim();
      const currentText = String(row[currentMap.index] ?? "").trim();
      const elapsedTimeSeconds = Number(timeText);
      const voltage = Number(voltageText);
      const currentValue = Number(currentText);
      if (!timeText || !Number.isFinite(elapsedTimeSeconds)) throw new Error(`Row ${displayRow}: elapsed time is missing or nonnumeric.`);
      if (!voltageText || !Number.isFinite(voltage)) throw new Error(`Row ${displayRow}: voltage is missing or nonnumeric.`);
      if (!currentText || !Number.isFinite(currentValue)) throw new Error(`Row ${displayRow}: ${currentMap.role} is missing or nonnumeric.`);
      return { elapsedTimeSeconds, voltage, ...currentMap.convert(currentValue) };
    });
    if (!points.length) throw new Error("No data rows were found.");
    if (points.some(point => point.elapsedTimeSeconds < 0)) throw new Error("Elapsed time cannot be negative.");
    for (let index = 1; index < points.length; index += 1) {
      if (points[index].elapsedTimeSeconds < points[index - 1].elapsedTimeSeconds) throw new Error("Elapsed time values must be in chronological order.");
      if (points[index].elapsedTimeSeconds === points[index - 1].elapsedTimeSeconds) throw new Error("Elapsed time contains duplicated values.");
    }
    return {
      points,
      voltageSeries: points.map(point => ({ elapsedTimeSeconds: point.elapsedTimeSeconds, voltage: point.voltage })),
      currentSeries: points.map(point => ({ elapsedTimeSeconds: point.elapsedTimeSeconds, current: point.current, currentDensity: point.currentDensity })),
      alignment: { method: "direct", overlapStartSeconds: points[0].elapsedTimeSeconds, overlapEndSeconds: points[points.length - 1].elapsedTimeSeconds },
    };
  }

  function readTestBridgeSeries(inspection, mapping, electrodeAreaCm2) {
    assertColumnIndex(inspection.headers, mapping.time, "Voltage timestamp");
    assertColumnIndex(inspection.headers, mapping.voltage, "Voltage");
    assertColumnIndex(inspection.headers, mapping.currentTime, "Current timestamp");
    const currentMap = currentMapping(inspection, mapping, electrodeAreaCm2);
    if (mapping.time === mapping.voltage || mapping.currentTime === currentMap.index || mapping.voltage === currentMap.index) throw new Error("Timestamp, voltage, and current mappings conflict.");
    const voltageRaw = [];
    const currentRaw = [];
    inspection.rows.forEach((row, rowIndex) => {
      const displayRow = inspection.headerRowIndex + rowIndex + 2;
      const voltageText = String(row[mapping.voltage] ?? "").trim();
      const voltageTimeText = String(row[mapping.time] ?? "").trim();
      const currentText = String(row[currentMap.index] ?? "").trim();
      const currentTimeText = String(row[mapping.currentTime] ?? "").trim();
      if (voltageText) {
        const voltage = Number(voltageText);
        const absoluteTimeMs = parseTimestamp(voltageTimeText);
        if (!Number.isFinite(voltage)) throw new Error(`Row ${displayRow}: voltage is nonnumeric.`);
        if (!Number.isFinite(absoluteTimeMs)) throw new Error(`Row ${displayRow}: voltage timestamp is missing or invalid.`);
        voltageRaw.push({ absoluteTimeMs, value: voltage });
      }
      if (currentText) {
        const currentValue = Number(currentText);
        const absoluteTimeMs = parseTimestamp(currentTimeText);
        if (!Number.isFinite(currentValue)) throw new Error(`Row ${displayRow}: ${currentMap.role} is nonnumeric.`);
        if (!Number.isFinite(absoluteTimeMs)) throw new Error(`Row ${displayRow}: current timestamp is missing or invalid.`);
        currentRaw.push({ absoluteTimeMs, value: currentValue });
      }
    });
    if (!voltageRaw.length) throw new Error("No numeric voltage samples were found.");
    if (!currentRaw.length) throw new Error("No numeric current samples were found.");
    assertAscending(voltageRaw, "Voltage series");
    assertAscending(currentRaw, "Current series");
    return { voltageRaw, currentRaw, currentMap };
  }

  function normalizeTestBridge(inspection, mapping, electrodeAreaCm2) {
    const { voltageRaw, currentRaw, currentMap } = readTestBridgeSeries(inspection, mapping, electrodeAreaCm2);
    const experimentStartMs = Math.min(voltageRaw[0].absoluteTimeMs, currentRaw[0].absoluteTimeMs);
    const overlapStartMs = Math.max(voltageRaw[0].absoluteTimeMs, currentRaw[0].absoluteTimeMs);
    const overlapEndMs = Math.min(voltageRaw[voltageRaw.length - 1].absoluteTimeMs, currentRaw[currentRaw.length - 1].absoluteTimeMs);
    if (overlapEndMs < overlapStartMs) throw new Error("Voltage and current series have no shared time range.");
    const voltageSeries = voltageRaw.map(point => ({ elapsedTimeSeconds: (point.absoluteTimeMs - experimentStartMs) / 1000, voltage: point.value }));
    const currentSeries = currentRaw.map(point => ({ elapsedTimeSeconds: (point.absoluteTimeMs - experimentStartMs) / 1000, ...currentMap.convert(point.value) }));
    const alignedVoltage = voltageRaw.filter(point => point.absoluteTimeMs >= overlapStartMs && point.absoluteTimeMs <= overlapEndMs);
    const points = alignedVoltage.map(point => {
      const currentValue = interpolateAt(currentRaw, point.absoluteTimeMs);
      if (!Number.isFinite(currentValue)) throw new Error("Current interpolation failed inside the shared time range.");
      return { elapsedTimeSeconds: (point.absoluteTimeMs - experimentStartMs) / 1000, voltage: point.value, ...currentMap.convert(currentValue) };
    });
    if (!points.length) throw new Error("No voltage samples fall inside the shared voltage/current time range.");
    return {
      points, voltageSeries, currentSeries,
      alignment: {
        method: "linear-current-on-voltage-timeline",
        overlapStartSeconds: (overlapStartMs - experimentStartMs) / 1000,
        overlapEndSeconds: (overlapEndMs - experimentStartMs) / 1000,
      },
    };
  }

  function normalizeTestBridgeVoltageOnly(inspection, mapping) {
    assertColumnIndex(inspection.headers, mapping.time, "Voltage timestamp");
    assertColumnIndex(inspection.headers, mapping.voltage, "Voltage");
    if (mapping.time === mapping.voltage) throw new Error("Voltage timestamp and voltage mappings conflict.");
    const voltageRaw = [];
    inspection.rows.forEach((row, rowIndex) => {
      const displayRow = inspection.headerRowIndex + rowIndex + 2;
      const voltageText = String(row[mapping.voltage] ?? "").trim();
      const voltageTimeText = String(row[mapping.time] ?? "").trim();
      if (!voltageText) return;
      const voltage = Number(voltageText);
      const absoluteTimeMs = parseTimestamp(voltageTimeText);
      if (!Number.isFinite(voltage)) throw new Error(`Row ${displayRow}: voltage is nonnumeric.`);
      if (!Number.isFinite(absoluteTimeMs)) throw new Error(`Row ${displayRow}: voltage timestamp is missing or invalid.`);
      voltageRaw.push({ absoluteTimeMs, value: voltage });
    });
    if (!voltageRaw.length) throw new Error("No numeric voltage samples were found.");
    assertAscending(voltageRaw, "Voltage series");
    const experimentStartMs = voltageRaw[0].absoluteTimeMs;
    const voltageSeries = voltageRaw.map(point => ({
      elapsedTimeSeconds: (point.absoluteTimeMs - experimentStartMs) / 1000,
      voltage: point.value,
    }));
    return {
      points: voltageSeries.map(point => ({ ...point, current: null, currentDensity: null })),
      voltageSeries,
      currentSeries: [],
      voltageOnly: true,
      alignment: {
        method: "voltage-only",
        overlapStartSeconds: voltageSeries[0].elapsedTimeSeconds,
        overlapEndSeconds: voltageSeries[voltageSeries.length - 1].elapsedTimeSeconds,
      },
    };
  }

  function normalizeCsv(text, options) {
    const inspection = inspectCsv(text);
    const source = options?.source;
    const mapping = options?.mapping || {};
    if (![SOURCE_QPX, SOURCE_TEST_BRIDGE].includes(source)) throw new Error("Choose QPX600DP Readable or Test Bridge as the source format.");
    const voltageOnly = source === SOURCE_TEST_BRIDGE && options?.voltageOnly === true;
    const electrodeAreaCm2 = options?.electrodeAreaCm2 ?? 5;
    if (inspection.duplicateHeaders.length && !voltageOnly) throw new Error(`Duplicated required header${inspection.duplicateHeaders.length === 1 ? "" : "s"}: ${inspection.duplicateHeaders.join(", ")}.`);
    const normalized = source === SOURCE_QPX
      ? normalizeQpx(inspection, mapping, electrodeAreaCm2)
      : voltageOnly
        ? normalizeTestBridgeVoltageOnly(inspection, mapping)
        : normalizeTestBridge(inspection, mapping, electrodeAreaCm2);
    return {
      source,
      headers: inspection.headers.slice(),
      rawRows: inspection.allRows.map(row => row.slice()),
      metadataRows: inspection.metadataRows.map(row => row.slice()),
      ...normalized,
      mappedColumns: {
        time: inspection.headers[mapping.time],
        voltage: inspection.headers[mapping.voltage],
        currentTime: voltageOnly ? null : inspection.headers[source === SOURCE_QPX ? mapping.time : mapping.currentTime],
        current: voltageOnly ? null : inspection.headers[mapping.current],
      },
    };
  }

  function sourceLabel(source) {
    if (source === SOURCE_QPX) return "QPX600DP Readable";
    if (source === SOURCE_TEST_BRIDGE) return "Test Bridge";
    return "Uncertain";
  }

  function inferExperimentKind(points, filename) {
    const name = String(filename || "").toLowerCase();
    const words = name.replace(/[_-]+/g, " ");
    if (/\bbreak\b/.test(words)) return "break";
    if (/\blsv\b|\biv\b/.test(words)) return "iv";
    if (/\bhold\b|(?:^|\s)\d+\s*(?:h|hr|hour)s?\s*cp(?:\s|\.|$)/.test(words)) return "hold";

    const currents = (points || [])
      .map(point => Number(point.current))
      .filter(value => Number.isFinite(value) && Math.abs(value) > 0);
    if (currents.length < 3) return null;

    const bins = new Map();
    currents.forEach(value => {
      const bin = Math.round(value * 100) / 100;
      bins.set(bin, (bins.get(bin) || 0) + 1);
    });
    const dominantFraction = Math.max(...bins.values()) / currents.length;
    return dominantFraction >= 0.5 ? "hold" : "iv";
  }

  return { SOURCE_QPX, SOURCE_TEST_BRIDGE, parseCsv, parseTimestamp, inspectCsv, normalizeCsv, sourceLabel, normalizedHeader, interpolateAt, inferExperimentKind };
});
