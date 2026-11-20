<script>
  let count = 0;
  let name = "";
</script>

<div>
  <h1>Sample (Svelte)</h1>
  <button data-testid="decrement" on:click={() => (count -= 1)}>-</button>
  <span data-testid="count">{count}</span>
  <button data-testid="increment" on:click={() => (count += 1)}>+</button>
  <p>
    <input data-testid="name-input" placeholder="name" bind:value={name} />
  </p>
  <p data-testid="greeting">{name === "" ? "Hello" : `Hello, ${name}`}</p>
</div>
