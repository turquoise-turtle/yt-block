YTB.readManagedPolicy().then((raw) => {
  const { message } = YTB.normalisePolicy(raw);
  if (message) document.getElementById('message').textContent = message;
});
