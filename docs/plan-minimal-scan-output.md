# Plan: Minimalize `scan_dependencies` Success Output

## Problem
The `scan_dependencies` tool returns verbose success messages that include:
- Full index file path (`Index file path: C:\Users\...`)
- Sample index entries (lists 5 arbitrary classes)

This information is irrelevant to the LLM and wastes context window tokens.

## Solution
Reduce the `status === 'complete'` response to a single concise sentence.

## Affected File
`src/index.ts` — `handleScanDependencies` method.

## Current Output
```
Dependency scanning complete!

Scanned JAR count: 144
Indexed class count: 17405
Index file path: C:\Users\musta\.cache\java-inspector\...

Sample index entries:
com.vaadin.flow.spring.data.VaadinSpringDataHelpers -> vaadin-spring-24.3.0.jar
...
```

## Desired Output
```
Dependency scanning complete! Indexed 17405 classes from 144 JARs.
```

## Implementation
Replace the multi-line `text` string in the `complete` branch with:
```typescript
text: `Dependency scanning complete! Indexed ${result.classCount} classes from ${result.jarCount} JARs.`,
```

## Notes
- The `in_progress` response is intentionally left as-is; it already contains useful progress information.
- Other tool outputs (`decompile_class`, `analyze_class`, etc.) are out of scope for this plan.
