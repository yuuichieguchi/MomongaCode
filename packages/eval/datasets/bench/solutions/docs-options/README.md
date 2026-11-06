# truncate

Shortens text to a length.

```js
truncate(text, { maxLength: 10 });
```

## Options

| name | default | description |
| --- | --- | --- |
| `maxLength` | `80` | The longest result, ellipsis included. |
| `ellipsis` | `"…"` | Appended when the text is cut. |
| `wordBoundary` | `false` | Cut at the last whole word. |
