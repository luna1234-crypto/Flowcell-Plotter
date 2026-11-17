# Flowcell Plotter

A browser-based flowcell data plotting tool. It runs entirely in the browser; uploaded values remain local and unchanged.

## Use

1. Choose a flowcell folder.
2. Review the detected source format and time, voltage, and current columns.
3. Correct any uncertain mapping, then select **Process files**.
4. Add one or more material lines, configure their legend, colour, and style, then draw the IV and Hold charts.

Supported CSV sources:

- QPX600DP readable export: `Elapsed time (s), Voltage (V), Current (A)`
- Test Bridge export: optional `#` metadata plus `#TimeStamp,Volts,TimeStamp,Amps,On Demand`

Both sources are normalized in the processing layer to elapsed seconds, volts, and amperes. Raw imported strings and Test Bridge metadata are retained separately. Test Bridge voltage and current remain independent timestamped series for time traces. For IV calculations, current is linearly interpolated onto voltage timestamps only inside the shared time range; values are never extrapolated. Legacy Test Bridge files with one shared timestamp remain supported. iR correction is disabled by default and is applied only when the operator selects it.

## Checks

With Node.js available:

```sh
npm run check
npm run build
```
