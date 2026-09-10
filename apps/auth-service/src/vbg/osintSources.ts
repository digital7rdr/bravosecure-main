/**
 * Curated OSINT outlet registry — the founder's "GLOBAL OSINT SOURCES (WORLD
 * MONITOR)" directory (Notion), mapped country → outlet DOMAINS.
 *
 * These outlets are consumed through Google News RSS `site:` queries rather
 * than each outlet's own RSS endpoint: the directory lists ~600 outlet
 * HOMEPAGES, half of which have no (working) public feed, and probing them
 * individually is a flaky, unbounded surface. A single
 *   (site:a.com OR site:b.com …) … when:72h
 * search per (country, category) returns fresh items from exactly these
 * outlets, is completely free, and reuses the battle-tested RSS handling in
 * googlenews.service. Domains are capped per country to keep the query URL
 * well-formed.
 *
 * Consumers: newsfeed.service (curated half of every feed pair) and
 * vbg.service via googlenews.service (curated threat source).
 */

/** The page's top "GLOBAL OSINT SOURCES" wire/broadcaster list. */
export const OSINT_GLOBAL_DOMAINS: string[] = [
  'reuters.com', 'apnews.com', 'bbc.com', 'cnn.com', 'aljazeera.com',
  'bloomberg.com', 'news.sky.com', 'france24.com', 'dw.com',
];

const D: Record<string, string[]> = {
  // ── Africa ─────────────────────────────────────────────────────────────
  DZ: ['aps.dz', 'echoroukonline.com', 'tsa-algerie.com', 'ennaharonline.com', 'lesoirdalgerie.com'],
  EG: ['ahram.org.eg', 'dailynewsegypt.com', 'egyptindependent.com', 'egypttoday.com', 'almasryalyoum.com', 'elbalad.news'],
  LY: ['libyaobserver.ly', 'libyaherald.com', '218tv.net', 'alwasat.ly', 'addresslibya.com'],
  MA: ['map.ma', 'hespress.com', 'lematin.ma', 'medias24.com', 'telquel.ma', 'leconomiste.com'],
  SD: ['suna-news.net', 'sudantribune.com', 'dabangasudan.org', 'alrakoba.net', 'altaghyeer.info'],
  TN: ['tap.info.tn', 'lapresse.tn', 'mosaiquefm.net', 'tunisienumerique.com', 'businessnews.com.tn', 'webdo.tn'],
  NG: ['channelstv.com', 'premiumtimesng.com', 'punchng.com', 'vanguardngr.com', 'thecable.ng', 'dailytrust.com', 'thisdaylive.com'],
  GH: ['gna.org.gh', 'graphic.com.gh', 'citinewsroom.com', 'myjoyonline.com', 'ghanaweb.com', 'ghanaiantimes.com.gh'],
  SN: ['aps.sn', 'lesoleil.sn', 'seneweb.com', 'dakaractu.com', 'pressafrik.com'],
  CI: ['aip.ci', 'fratmat.info', 'rti.info', 'abidjan.net', 'koaci.com', 'linfodrome.com'],
  CD: ['acp.cd', 'radiookapi.net', 'actualite.cd', '7sur7.cd', 'mediacongo.net', 'politico.cd'],
  CM: ['crtv.cm', 'cameroon-tribune.cm', 'journalducameroun.com', 'actucameroun.com', 'cameroonnewsagency.com'],
  KE: ['nation.africa', 'standardmedia.co.ke', 'the-star.co.ke', 'citizen.digital', 'capitalfm.co.ke', 'businessdailyafrica.com'],
  ET: ['ena.et', 'addisstandard.com', 'fanabc.com', 'thereporterethiopia.com', 'ethiopianmonitor.com'],
  SO: ['sonna.so', 'hiiraan.com', 'garoweonline.com', 'somaliguardian.com', 'shabellemedia.com'],
  ZA: ['news24.com', 'dailymaverick.co.za', 'timeslive.co.za', 'mg.co.za', 'enca.com', 'sabcnews.com', 'iol.co.za', 'citizen.co.za'],
  NA: ['namibian.com.na', 'neweralive.na', 'nbc.na', 'observer24.com.na', 'economist.com.na'],
  ZW: ['herald.co.zw', 'newsday.co.zw', 'chronicle.co.zw', 'theindependent.co.zw', 'newzimbabwe.com', 'zbcnews.co.zw'],
  // ── Europe ─────────────────────────────────────────────────────────────
  FR: ['francetvinfo.fr', 'lemonde.fr', 'lefigaro.fr', 'france24.com', 'liberation.fr', 'lesechos.fr', 'leparisien.fr', 'rfi.fr'],
  DE: ['tagesschau.de', 'dw.com', 'spiegel.de', 'faz.net', 'sueddeutsche.de', 'welt.de', 'handelsblatt.com'],
  NL: ['nos.nl', 'nrc.nl', 'volkskrant.nl', 'rtlnieuws.nl', 'nu.nl', 'trouw.nl', 'ad.nl'],
  BE: ['rtbf.be', 'vrt.be', 'standaard.be', 'lesoir.be', 'lalibre.be', 'nieuwsblad.be', 'hln.be'],
  CH: ['srf.ch', 'rts.ch', 'nzz.ch', 'tagesanzeiger.ch', 'letemps.ch', 'blick.ch', 'swissinfo.ch'],
  GB: ['bbc.com', 'news.sky.com', 'theguardian.com', 'ft.com', 'thetimes.co.uk', 'telegraph.co.uk', 'itv.com'],
  SE: ['svt.se', 'sverigesradio.se', 'dn.se', 'svd.se', 'aftonbladet.se', 'expressen.se', 'gp.se'],
  NO: ['nrk.no', 'aftenposten.no', 'vg.no', 'dagbladet.no', 'tv2.no', 'e24.no', 'nettavisen.no'],
  DK: ['dr.dk', 'tv2.dk', 'berlingske.dk', 'politiken.dk', 'jyllands-posten.dk', 'borsen.dk', 'ekstrabladet.dk'],
  FI: ['yle.fi', 'hs.fi', 'is.fi', 'iltalehti.fi', 'mtvuutiset.fi', 'kauppalehti.fi'],
  IT: ['ansa.it', 'rainews.it', 'corriere.it', 'repubblica.it', 'ilsole24ore.com', 'lastampa.it', 'adnkronos.com', 'agi.it'],
  ES: ['efe.com', 'rtve.es', 'elpais.com', 'elmundo.es', 'abc.es', 'lavanguardia.com', 'elconfidencial.com', 'europapress.es'],
  PT: ['lusa.pt', 'rtp.pt', 'publico.pt', 'dn.pt', 'expresso.pt', 'sicnoticias.pt', 'observador.pt', 'jn.pt'],
  GR: ['amna.gr', 'ertnews.gr', 'kathimerini.gr', 'tovima.gr', 'tanea.gr', 'protothema.gr', 'ekathimerini.com'],
  RU: ['tass.com', 'interfax.com', 'kommersant.ru', 'rbc.ru', 'meduza.io', 'novayagazeta.eu', 'themoscowtimes.com'],
  UA: ['ukrinform.net', 'suspilne.media', 'kyivindependent.com', 'pravda.com.ua', 'nv.ua', 'unian.info', 'euromaidanpress.com'],
  PL: ['pap.pl', 'tvp.info', 'polsatnews.pl', 'tvn24.pl', 'rp.pl', 'wyborcza.pl', 'rmf24.pl'],
  CZ: ['ceskatelevize.cz', 'irozhlas.cz', 'seznamzpravy.cz', 'idnes.cz', 'denikn.cz', 'novinky.cz'],
  HU: ['telex.hu', '444.hu', 'hvg.hu', 'index.hu', 'nepszava.hu', 'magyarnemzet.hu'],
  SK: ['tasr.sk', 'rtvs.sk', 'sme.sk', 'dennikn.sk', 'aktuality.sk', 'ta3.com'],
  RS: ['tanjug.rs', 'rts.rs', 'n1info.rs', 'b92.net', 'politika.rs', 'danas.rs', 'euronews.rs'],
  HR: ['hina.hr', 'hrt.hr', 'jutarnji.hr', 'vecernji.hr', 'index.hr', '24sata.hr', 'n1info.hr'],
  RO: ['agerpres.ro', 'digi24.ro', 'hotnews.ro', 'adevarul.ro', 'libertatea.ro', 'g4media.ro', 'zf.ro'],
  EE: ['err.ee', 'postimees.ee', 'delfi.ee', 'ohtuleht.ee', 'aripaev.ee'],
  LV: ['leta.lv', 'lsm.lv', 'tvnet.lv', 'delfi.lv', 'la.lv', 'bnn-news.com'],
  LT: ['lrt.lt', 'delfi.lt', '15min.lt', 'lrytas.lt', 'vz.lt'],
  // ── Middle East / Caucasus / Central Asia ──────────────────────────────
  BH: ['bna.bh', 'bahrainmirror.com', 'alayam.com', 'albiladpress.com', 'akhbar-alkhaleej.com'],
  IR: ['irna.ir', 'tasnimnews.com', 'mehrnews.com', 'farsnews.ir', 'tehrantimes.com', 'presstv.ir', 'iranintl.com'],
  IQ: ['ina.iq', 'rudaw.net', 'shafaq.com', 'alsumaria.tv', 'basnews.com', 'baghdadtoday.news'],
  IL: ['ynetnews.com', 'timesofisrael.com', 'haaretz.com', 'jpost.com', 'i24news.tv', 'israelhayom.com'],
  SA: ['spa.gov.sa', 'arabnews.com', 'alarabiya.net', 'saudigazette.com.sa', 'okaz.com.sa', 'sabq.org', 'aawsat.com'],
  AE: ['wam.ae', 'thenationalnews.com', 'gulfnews.com', 'khaleejtimes.com', 'emirates247.com', 'arabianbusiness.com'],
  AM: ['armenpress.am', 'armradio.am', 'news.am', 'hetq.am', 'civilnet.am'],
  AZ: ['azertag.az', 'trend.az', 'apa.az', 'report.az', 'azernews.az'],
  GE: ['agenda.ge', 'civil.ge', 'interpressnews.ge', 'imedinews.ge', 'georgiatoday.ge'],
  KZ: ['inform.kz', 'tengrinews.kz', 'informburo.kz', 'astanatimes.com', 'vlast.kz'],
  UZ: ['uza.uz', 'kun.uz', 'gazeta.uz', 'daryo.uz', 'uzreport.news', 'uzdaily.uz'],
  // ── South / Southeast / East Asia ──────────────────────────────────────
  IN: ['ptinews.com', 'aninews.in', 'thehindu.com', 'indianexpress.com', 'timesofindia.indiatimes.com', 'hindustantimes.com', 'ndtv.com'],
  PK: ['app.com.pk', 'dawn.com', 'thenews.com.pk', 'geo.tv', 'arynews.tv', 'tribune.com.pk', 'brecorder.com'],
  BD: ['bssnews.net', 'thedailystar.net', 'dhakatribune.com', 'prothomalo.com', 'bdnews24.com', 'tbsnews.net'],
  ID: ['antaranews.com', 'kompas.com', 'detik.com', 'tempo.co', 'cnnindonesia.com', 'thejakartapost.com'],
  MY: ['bernama.com', 'thestar.com.my', 'nst.com.my', 'malaysiakini.com', 'freemalaysiatoday.com', 'malaymail.com'],
  SG: ['channelnewsasia.com', 'straitstimes.com', 'todayonline.com', 'businesstimes.com.sg', 'mothership.sg', 'asiaone.com'],
  TH: ['bangkokpost.com', 'nationthailand.com', 'thaipbsworld.com', 'khaosodenglish.com', 'thairath.co.th'],
  PH: ['pna.gov.ph', 'abs-cbn.com', 'gmanetwork.com', 'rappler.com', 'inquirer.net', 'philstar.com'],
  CN: ['news.cn', 'chinadaily.com.cn', 'globaltimes.cn', 'cgtn.com', 'caixinglobal.com', 'sixthtone.com'],
  JP: ['kyodonews.net', 'asahi.com', 'japannews.yomiuri.co.jp', 'asia.nikkei.com', 'mainichi.jp', 'japantimes.co.jp'],
  KR: ['yna.co.kr', 'koreaherald.com', 'koreatimes.co.kr', 'koreajoongangdaily.joins.com', 'chosun.com', 'hani.co.kr'],
  TW: ['focustaiwan.tw', 'taipeitimes.com', 'udn.com', 'ltn.com.tw', 'chinatimes.com'],
  // ── Americas ───────────────────────────────────────────────────────────
  US: ['apnews.com', 'reuters.com', 'bloomberg.com', 'nytimes.com', 'wsj.com', 'washingtonpost.com', 'cnn.com', 'nbcnews.com'],
  CA: ['cbc.ca', 'ctvnews.ca', 'globalnews.ca', 'theglobeandmail.com', 'nationalpost.com', 'lapresse.ca', 'bnnbloomberg.ca'],
  MX: ['eluniversal.com.mx', 'milenio.com', 'reforma.com', 'jornada.com.mx', 'excelsior.com.mx', 'elfinanciero.com.mx', 'animalpolitico.com'],
  BZ: ['breakingbelizenews.com', 'lovefm.com', 'amandala.com.bz', '7newsbelize.com', 'reporter.bz'],
  CR: ['nacion.com', 'crhoy.com', 'teletica.com', 'delfino.cr', 'larepublica.net'],
  SV: ['laprensagrafica.com', 'elsalvador.com', 'elfaro.net', 'diariocolatino.com'],
  GT: ['prensalibre.com', 'soy502.com', 'lahora.gt', 'publinews.gt', 'agn.gt'],
  HN: ['laprensa.hn', 'elheraldo.hn', 'proceso.hn', 'latribuna.hn', 'tiempo.hn'],
  NI: ['laprensani.com', 'confidencial.digital', '100noticias.com.ni', 'articulo66.com', 'nicaraguainvestiga.com'],
  PA: ['prensa.com', 'tvn-2.com', 'telemetro.com', 'laestrella.com.pa', 'panamaamerica.com.pa'],
  JM: ['jamaicaobserver.com', 'jamaica-gleaner.com', 'jamaica.loopnews.com', 'nationwideradiojm.com', 'jis.gov.jm'],
  TT: ['newsday.co.tt', 'trinidadexpress.com', 'tt.loopnews.com', 'cnc3.co.tt', 'guardian.co.tt'],
  DO: ['diariolibre.com', 'listindiario.com', 'elcaribe.com.do', 'hoy.com.do', 'acento.com.do', 'noticiassin.com'],
  BS: ['tribune242.com', 'ewnews.com', 'znsbahamas.com', 'ournews.bs', 'thenassauguardian.com'],
  BB: ['nationnews.com', 'barbadostoday.bb', 'cbc.bb', 'barbados.loopnews.com', 'barbadosadvocate.com'],
  CO: ['eltiempo.com', 'elespectador.com', 'semana.com', 'bluradio.com', 'caracol.com.co', 'noticiasrcn.com'],
  VE: ['elnacional.com', 'eluniversal.com', 'talcualdigital.com', 'efectococuyo.com', 'lapatilla.com'],
  GY: ['stabroeknews.com', 'kaieteurnewsonline.com', 'newsroom.gy', 'guyanachronicle.com', 'demerarawaves.com'],
  SR: ['starnieuws.com', 'waterkant.net', 'dwtonline.com', 'dbsuriname.com', 'surinameherald.com'],
  BO: ['abi.bo', 'la-razon.com', 'eldeber.com.bo', 'lostiempos.com', 'paginasiete.bo'],
  EC: ['eluniverso.com', 'elcomercio.com', 'primicias.ec', 'teleamazonas.com', 'ecuavisa.com'],
  PE: ['andina.pe', 'elcomercio.pe', 'larepublica.pe', 'peru21.pe', 'rpp.pe', 'gestion.pe'],
  AR: ['clarin.com', 'lanacion.com.ar', 'infobae.com', 'pagina12.com.ar', 'ambito.com', 'tn.com.ar', 'perfil.com'],
  CL: ['latercera.com', 'biobiochile.cl', 'cooperativa.cl', 'cnnchile.com', '24horas.cl', 'elmostrador.cl'],
  PY: ['ip.gov.py', 'abc.com.py', 'ultimahora.com', 'lanacion.com.py', 'hoy.com.py'],
  UY: ['elpais.com.uy', 'elobservador.com.uy', 'ladiaria.com.uy', 'montevideo.com.uy', 'subrayado.com.uy'],
  BR: ['agenciabrasil.ebc.com.br', 'folha.uol.com.br', 'oglobo.globo.com', 'estadao.com.br', 'g1.globo.com', 'cnnbrasil.com.br'],
  // ── Oceania ────────────────────────────────────────────────────────────
  AU: ['abc.net.au', 'sbs.com.au', 'theaustralian.com.au', 'smh.com.au', '9news.com.au', '7news.com.au', 'skynews.com.au', 'afr.com'],
  NZ: ['rnz.co.nz', 'nzherald.co.nz', 'stuff.co.nz', '1news.co.nz', 'newshub.co.nz', 'odt.co.nz'],
  FJ: ['fijisun.com.fj', 'fijitimes.com.fj', 'fbcnews.com.fj', 'fijilive.com', 'fijivillage.com'],
  PG: ['postcourier.com.pg', 'thenational.com.pg', 'emtv.com.pg', 'looppng.com', 'pngfacts.com'],
  SB: ['solomonstarnews.com', 'sibconline.com.sb', 'theislandsun.com.sb', 'solomontimes.com'],
  VU: ['dailypost.vu', 'vbtc.vu', 'vanuatu.loopnews.com', 'yumitoktokstret.com'],
  FM: ['kpress.info', 'islandtimes.org', 'mvariety.com', 'pacificislandtimes.com', 'guampdn.com'],
  KI: ['kiribatiindependent.org', 'pireport.org', 'islandsbusiness.com'],
  MH: ['marshallislandsjournal.com', 'yokwe.net', 'pireport.org', 'islandsbusiness.com'],
  NR: ['naurubulletin.com', 'pireport.org', 'islandsbusiness.com'],
  PW: ['islandtimes.org', 'palauwave.com', 'mvariety.com', 'palaugov.pw'],
  WS: ['samoaobserver.ws', 'sbc.ws', 'talanei.com', 'samoa.loopnews.com', 'samoaglobalnews.com'],
  TO: ['matangitonga.to', 'kanivatonga.nz', 'tonga.loopnews.com'],
  TV: ['tuvalunews.com', 'pireport.org', 'islandsbusiness.com'],
};

/** Curated outlet domains for a country ('GLOBAL' or ISO2); [] when uncovered. */
export function osintDomainsFor(country: string | null | undefined): string[] {
  const c = (country ?? '').trim().toUpperCase();
  if (!c) {return [];}
  if (c === 'GLOBAL') {return OSINT_GLOBAL_DOMAINS;}
  return D[c] ?? [];
}

/** `(site:a.com OR site:b.com …)` clause for a Google News search query. */
export function siteClause(domains: string[]): string {
  return `(${domains.map(d => `site:${d}`).join(' OR ')})`;
}
