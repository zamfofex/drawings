import {PNG} from "npm:pngjs@7.0.0"
import {formatRelative} from "npm:date-fns@3.3.1"

let db = await Deno.openKv()

let base = "https://drawings.deno.dev"

let width = 320
let height = 240

// from <https://alumni.media.mit.edu/~wad/color/palette.html>
let palette =
[
	[0, 0, 0], // black
	[87, 87, 87], // dark gray
	[160, 160, 160], // light gray
	[255, 255, 255], // white
	[42, 75, 215], // blue
	[29, 105, 20], // green
	[129, 74, 25], // brown
	[129, 38, 192], // purple
	[157, 175, 255], // light blue
	[129, 197, 122], // light green
	[233, 222, 187], // tan
	[173, 35, 35], // red
	[41, 208, 208], // cyan
	[255, 238, 51], // yellow
	[255, 146, 51], // orange
	[255, 205, 243], // pink
]

let ID = () =>
{
	let [random] = crypto.getRandomValues(new BigUint64Array(1))
	
	let id = ""
	for (let i = 0 ; i < 8 ; i++)
	{
		let value = random % 26n
		random /= 26n
		id += String.fromCodePoint(0x61 + Number(value))
	}
	
	return id
}

let isValidGalleryName = name =>
{
	if (/[^a-z0-9-]/.test(name)) return
	if (name.includes("--")) return
	if (name.startsWith("-")) return
	if (name.endsWith("-")) return
	if (name.length < 3) return
	if (name.length > 50) return
	if (name === "all") return
	return true
}

let escape = string => string.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")

let drawPage = await Deno.readFile(new URL("draw.html", import.meta.url))
let layout = await Deno.readTextFile(new URL("layout.html", import.meta.url))

let Draw = name =>
{
	if (!isValidGalleryName(name)) return new Response("invalid gallery name", {status: 400})
	return new Response(drawPage, {headers: {"content-type": "text/html"}})
}

let Share = async (buffer, name, remote) =>
{
	let bytes = new Uint8Array(buffer)
	if (bytes.length !== width * height / 2) return new Response("invalid drawing", {status: 400})
	if (bytes.every(byte => byte === 51)) return new Response("empty drawing", {status: 400})
	
	if (!isValidGalleryName(name)) return new Response("invalid gallery name", {status: 400})
	
	let entry = await db.get(["addresses", remote, "shared"])
	if (entry.value) return new Response("wait a few seconds before posting", {status: 429})
	
	let date = Date.now()
	let existing
	let id
	
	let op = db.atomic()
	
	while (true)
	{
		id = ID()
		existing = await db.get(["drawings", id])
		if (!existing.value) break
	}
	
	op.check(entry, existing)
	op.set(["addresses", remote, "shared"], true, {expireIn: 15000})
	op.set(["drawings", id], {bytes, date, gallery: name})
	op.set(["galleries", name, date, id], true)
	op.set(["galleries", "all", date, id], true)
	
	let result = await op.commit()
	if (!result.ok) return new Response("internal error", {status: 500})
	
	return new Response(id)
}

let Gallery = async name =>
{
	if (!isValidGalleryName(name) && name !== "all") return new Response("invalid gallery name", {status: 400})
	
	let page = layout
	
	if (name === "all")
		page += "<h2> all drawings </h2>"
	else if (name !== "public")
		page += `<h2> ${name.replaceAll("-", " ")} </h2>`
	
	if (name !== "public" && name !== "all")
		page += `<p class="share"> <a href="/draw?${name}">share a drawing to this gallery!</a> </p>`
	
	page += `<p class="gallery">`
	
	for await (let {key} of db.list({prefix: ["galleries", name]}, {reverse: true, limit: 200}))
	{
		let id = key[3]
		page += `<a href="/${id}"><img loading="lazy" src="/${id}.png" width="${width}" height="${height}"></a>`
	}
	
	page += `</p>`
	
	return new Response(page, {headers: {"content-type": "text/html"}})
}

let Drawing = async (id, remote) =>
{
	let {value} = await db.get(["drawings", id])
	if (value === null) return
	
	let page = layout
	
	page += `<meta name="twitter:card" content="summary_large_image">`
	page += `<meta property="og:type" content="website">`
	page += `<meta property="og:title" content="anonymously shared drawing">`
	page += `<meta property="og:url" content="${base}/${id}">`
	page += `<meta property="og:image" content="${base}/${id}.png">`
	
	page += `<p class="main"> <img src="/${id}.png" width="${width}" height="${height}"> </p>`
	page += `<p class="info"> shared ${escape(formatRelative(value.date, Date.now()))} </p>`
	
	if (value.gallery === "public")
	{
		let {value} = await db.get(["addresses", remote, "bumped", id])
		if (value) page += `<p class="info"> <em>bumped!</em> </p>`
		else page += `<form class="info" method="POST"> <button>bump!</button> </form>`
	}
	else
	{
		page += `<p class="info"> <a href="/galleries/${value.gallery}">on gallery \u201C${value.gallery.replaceAll("-", " ")}\u201D</a> </p>`
	}
	
	return new Response(page, {headers: {"content-type": "text/html"}})
}

let Image = async id =>
{
	let {value} = await db.get(["drawings", id])
	if (value === null) return
	let bytes = value.data
	
	let png = new PNG({width, height})
	let data = png.data
	
	for (let i = 0 ; i < data.length ; i += 4)
	{
		let index = value.bytes[Math.floor(i / 8)]
		if (i % 8 !== 0) index >>>= 4
		index &= 0x0F
		
		data[i + 0] = palette[index][0]
		data[i + 1] = palette[index][1]
		data[i + 2] = palette[index][2]
		data[i + 3] = 0xFF
	}
	
	return new Response(PNG.sync.write(png, {colorType: 2}), {headers: {"content-type": "image/png"}})
}

let Bump = async (id, remote) =>
{
	let [entry, entry1] = await db.getMany([["drawings", id], ["addresses", remote, "bumped", id]])
	if (entry.value === null) return
	if (entry.value.gallery !== "public") return new Response("cannot bump", {status: 400})
	if (entry1.value) return new Response("already bumped", {status: 400})
	
	let date = Date.now()
	
	let score = entry.value.score ?? entry.value.date
	
	let key = ["galleries", "public", score, id]
	
	let entry2 = await db.get(key)
	if (!entry2.value) return new Response("internal error", {status: 500})
	
	score = (score + date) / 2
	
	let op = db.atomic()
	
	op.check(entry, entry1, entry2)
	op.delete(key)
	op.set(["galleries", "public", score, id], true)
	op.set(["addresses", remote, "bumped", id], true, {expireIn: 86400000})
	op.set(["drawings", id], {...entry.value, score})
	
	let result = await op.commit()
	if (!result.ok) return new Response("internal error", {status: 500})
	
	return new Response("redirect", {status: 302, headers: {location: `/${id}`}})
}

let About = () =>
{
	let page = layout
	
	page += "<h2> what is this? </h2>"
	page += "<p> This is a website where you can make and share drawings! All drawings are shared anonymously and can be seen by anyone. You can make drawings by clicking the “draw” button above, and then share it from that page. </p>"
	page += `<p> This website is free software! Its source code is <a href="https://github.com/zamfofex/drawings">available on GitHub</a>. </p>`
	
	page += "<h2> what are galleries? </h2>"
	page += "<p> Galleries are a simple way for people to organise their shared drawings! Whenever someone shares a drawing to a gallery, their drawing will be made visible in that gallery’s page, rather than on the home page. </p>"
	page += "<p> To create a gallery, you can simply type the name of a gallery on the “gallery” field on the top of the page, and <em>go!</em> </p>"
	page += "<p> All galleries are public and can be referred to by name. That means that anyone can post a drawing to any gallery, and no gallery belongs to anyone. If different people try to use the same gallery name, they will be referred to the exact same gallery. </p>"
	page += `<p> There is also <a href="/galleries/all">a page that shows drawings shared to any gallery</a>, rather than just the ones shared to the home page. </p>`
	
	page += "<h2> rules </h2>"
	page += "<ol>"
	page += "<li> <strong>Follow the law!</strong> (Drawings that break the law will be excluded.)"
	page += "<li> <strong>Only share drawings made in the website itself.</strong> (Do not try to share drawings made elsewhere nor to use the website to store arbitrary data.)"
	page += "<li> <strong>Drawings shared to the website are public.</strong> (This means anyone may use them for any reason they might have.)"
	page += "</ol>"
	
	return new Response(page, {headers: {"content-type": "text/html"}})
}

Deno.serve(async (request, {remoteAddr: {hostname: remote}}) =>
{
	let url = new URL(request.url)
	
	if (request.method === "GET" && url.pathname === "/" && url.search === "")
		return Gallery("public")
	
	if (request.method === "GET" && url.pathname === "/draw")
	{
		let name = "public"
		if (url.search !== "") name = url.search.slice(1)
		return Draw(name)
	}
	
	if (request.method === "POST" && url.pathname === "/share")
		return Share(await request.arrayBuffer(), url.searchParams.get("gallery") || "public", remote)
	
	if (request.method === "GET" && url.pathname === "/about" && url.search === "")
		return About()
	
	if (request.method === "GET" && url.pathname === "/galleries")
	{
		let name = url.searchParams.get("name").toLowerCase().replaceAll("-", " ").trim().replace(/ +/g, "-")
		return new Response("redirect", {status: 302, headers: {location: `/galleries/${name}`}})
	}
	
	if (request.method === "GET" && url.pathname.startsWith("/galleries/") && url.search === "")
	{
		let name = url.pathname.slice("/galleries/".length)
		if (name === "public") return new Response("redirect", {status: 302, headers: {location: "/"}})
		return await Gallery(name)
	}
	
	if (request.method === "GET" && url.search === "")
	{
		let id = url.pathname.slice(1)
		if (id.endsWith(".png"))
		{
			id = id.slice(0, -".png".length)
			let response = await Image(id)
			if (response) return response
		}
		else
		{
			let response = await Drawing(id, remote)
			if (response) return response
		}
	}
	
	if (request.method === "POST" && url.search === "")
	{
		let id = url.pathname.slice(1)
		let response = await Bump(id, remote)
		if (response) return response
	}
	
	return new Response("not found", {status: 404})
})
