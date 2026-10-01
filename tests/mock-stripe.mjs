const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  const url=new URL(input);
  if(url.hostname==='api.stripe.com') input=process.env.MOCK_STRIPE_URL+url.pathname;
  return originalFetch(input,options);
};
