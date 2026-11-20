<script>
  const KEY = "tidal-draft";
  let saved = false;
  let draft = "";
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "{}");
    draft = p.draft || "";
    saved = !!p.saved;
  } catch {}

  $: status = draft === "" ? "empty" : saved ? "saved" : "dirty";
  $: localStorage.setItem(KEY, JSON.stringify({ draft, saved }));
</script>

<div>
  <input data-testid="draft-input" bind:value={draft} on:input={() => (saved = false)} />
  <button data-testid="save-button" on:click={() => (saved = true)}>save</button>
  <button
    data-testid="discard-button"
    on:click={() => {
      draft = "";
      saved = false;
    }}>discard</button
  >
  <span data-testid="draft-status">{status}</span>
</div>
