/**
 * B-91 M1 R4 — the permanently pinned sponsored slot (spec p.7).
 *
 * Reserved FIRST position above every chat (including user-pinned ones):
 * one advertising card, clearly labelled SPONSORED with a distinct treatment
 * so it can never be mistaken for a message, and no way for the user to
 * remove it. Campaign content is remote (`adsApi.getPinnedCampaign`) with a
 * bundled fallback until the ads endpoint ships (INDEX Q3) — the fallback
 * demonstrates position only, per the spec's placeholder note.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Linking, Image} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {adsApi, type SponsoredCampaign} from '@services/api';

const FALLBACK: SponsoredCampaign = {
  headline: 'Apex Executive Travel',
  body: 'Premium airport transfers across the UAE.',
  cta_label: 'Book Now',
  cta_url: 'https://bravosecure.app/partners',
};

// One fetch per app session — the slot renders instantly from fallback/cache
// and silently upgrades when the remote campaign lands.
let cached: SponsoredCampaign | null = null;
let fetched = false;

export function SponsoredSlot() {
  const [campaign, setCampaign] = useState<SponsoredCampaign>(cached ?? FALLBACK);

  useEffect(() => {
    if (fetched) {return;}
    fetched = true;
    adsApi.getPinnedCampaign()
      .then(res => {
        if (res.data?.headline && res.data?.cta_url) {
          cached = res.data;
          setCampaign(res.data);
        }
      })
      .catch(() => { /* endpoint not deployed yet — keep the fallback */ });
  }, []);

  return (
    <View style={s.card} accessibilityLabel={`Sponsored: ${campaign.headline}`}>
      <View style={s.topRow}>
        <Text style={s.eyebrow}>SPONSORED</Text>
        <Icon name="pin" size={12} color="rgba(180,188,204,0.45)" />
      </View>
      <View style={s.bodyRow}>
        {campaign.icon_url ? (
          <Image source={{uri: campaign.icon_url}} style={s.icon} />
        ) : (
          <View style={[s.icon, s.iconFallback]}>
            <Icon name="shield-star" size={20} color="#5B8DEF" />
          </View>
        )}
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headline} numberOfLines={1}>{campaign.headline}</Text>
          <Text style={s.body} numberOfLines={2}>{campaign.body}</Text>
          <TouchableOpacity
            accessibilityRole="link"
            accessibilityLabel={campaign.cta_label}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            onPress={() => { void Linking.openURL(campaign.cta_url).catch(() => {}); }}>
            <Text style={s.cta}>{campaign.cta_label} →</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    marginHorizontal: 14, marginTop: 8, marginBottom: 4,
    padding: 12, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.06)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
  },
  topRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8},
  eyebrow: {fontFamily: 'monospace', fontSize: 9, fontWeight: '800', letterSpacing: 2, color: '#5B8DEF'},
  bodyRow: {flexDirection: 'row', gap: 12},
  icon: {width: 42, height: 42, borderRadius: 12},
  iconFallback: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  headline: {color: '#F2F4F8', fontSize: 13.5, fontWeight: '700'},
  body: {color: 'rgba(229,233,242,0.62)', fontSize: 11.5, marginTop: 2, lineHeight: 15},
  cta: {color: '#5B8DEF', fontSize: 12, fontWeight: '700', marginTop: 6},
});
