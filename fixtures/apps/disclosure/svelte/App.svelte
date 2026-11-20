<script>
  const KEY = "tidal-disclosure";
  const NOTE_KEY = "tidal-disclosure-note";
  let open = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "open";
  let note = typeof localStorage !== "undefined" ? localStorage.getItem(NOTE_KEY) ?? "" : "";

  $: localStorage.setItem(KEY, open ? "open" : "closed");
  $: localStorage.setItem(NOTE_KEY, note);
</script>

<div>
  <button data-testid="toggle-button" on:click={() => (open = !open)}>{open ? "close" : "open"}</button>
  <span data-testid="panel-status">{open ? "open" : "closed"}</span>
  <span data-testid="note-status">{note === "" ? "empty" : "fed"}</span>
  {#if open}
    <div data-testid="panel">details</div>
  {/if}
  <input data-testid="note-input" bind:value={note} />
</div>
