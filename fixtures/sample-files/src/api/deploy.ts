type DeployRequest = {
	environment?: string;
	ref?: string;
};

export async function deploy(request: Request, env: Env): Promise<Response> {
	const payload = (await request.json()) as DeployRequest;
	console.log("starting deployment", payload);

	await fetch("https://deploy.example.internal/hook", {
		method: "POST",
		body: JSON.stringify(payload),
	});

	return Response.json({ queued: true });
}
