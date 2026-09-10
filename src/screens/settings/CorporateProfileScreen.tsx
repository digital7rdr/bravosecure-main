import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import {familyApi, type FamilyMember} from '@/services/api';
import {goBackOnce} from '@navigation/tapGuard';

const PRO_INDIGO = '#6366F1';

type ApprovalState = 'pending' | 'approved' | 'rejected';

interface MemberRow {
  initials: string; bg: string; color: string; name: string; role: string;
  badge: {label: string; color: string; bg: string; border: string} | null;
}

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

export default function CorporateProfileScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const user = useAuthStore(s => s.user);
  const [approvalState, setApprovalState] = useState<ApprovalState>('approved');
  const [showInviteToast, setShowInviteToast] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);

  // Company / account name comes from the signed-in user, not a placeholder.
  const companyName = user?.full_name || 'My Organisation';

  const load = useCallback(async () => {
    try {
      const {data} = await familyApi.members();
      const rows: MemberRow[] = (data.members ?? []).map((m: FamilyMember, i) => ({
        initials: initialsOf(m.name),
        bg: i === 0 ? 'rgba(245,158,11,0.15)' : 'rgba(99,102,241,0.15)',
        color: i === 0 ? '#FCD34D' : '#A5B4FC',
        name: m.name,
        role: typeof m.spendLimit === 'number' ? `Limit ${m.spendLimit.toLocaleString()} BC` : 'Member',
        badge: i === 0 ? {label: 'HOLDER', color: '#FCD34D', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.2)'} : null,
      }));
      setMembers(rows);
    } catch {
      setMembers([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const handleAddMember = () => {
    setShowInviteToast(true);
    setTimeout(() => setShowInviteToast(false), 3000);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Corporate Profile</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {/* Company Card */}
        <View style={styles.companyCard}>
          <View style={styles.companyRow}>
            <View style={styles.companyIconWrap}>
              <Icon name="domain" size={28} color={PRO_INDIGO} />
            </View>
            <View style={styles.companyInfo}>
              <Text style={styles.companyName}>{companyName}</Text>
              <View style={styles.companyBadges}>
                <View style={[styles.badge, {backgroundColor:'rgba(99,102,241,0.15)', borderColor:'rgba(99,102,241,0.3)'}]}>
                  <Text style={[styles.badgeText, {color:'#A5B4FC'}]}>CORPORATE</Text>
                </View>
                <View style={[styles.badge, {backgroundColor:'rgba(34,197,94,0.12)', borderColor:'rgba(34,197,94,0.25)'}]}>
                  <Text style={[styles.badgeText, {color:'#86EFAC'}]}>VERIFIED</Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* Members */}
        <View style={styles.membersCard}>
          <View style={styles.memberCardHeader}>
            <Text style={styles.memberCardLabel}>Members <Text style={styles.memberCardCount}>(4 / 10 MAX)</Text></Text>
            <TouchableOpacity style={styles.addBtn} onPress={handleAddMember} activeOpacity={0.7}>
              <Icon name="plus" size={14} color={PRO_INDIGO} />
            </TouchableOpacity>
          </View>
          {members.length === 0 ? (
            <Text style={styles.emptyMembers}>No team members yet. Tap + to invite.</Text>
          ) : members.map((m, idx) => (
            <View key={idx} style={styles.memberRow}>
              <View style={[styles.memberAvatar, {backgroundColor: m.bg}]}>
                <Text style={[styles.memberAvatarText, {color: m.color}]}>{m.initials}</Text>
              </View>
              <View style={styles.memberInfo}>
                <Text style={styles.memberName}>{m.name}</Text>
                <Text style={styles.memberRole}>{m.role}</Text>
              </View>
              {m.badge && (
                <View style={[styles.badge, {backgroundColor: m.badge.bg, borderColor: m.badge.border}]}>
                  <Text style={[styles.badgeText, {color: m.badge.color}]}>{m.badge.label}</Text>
                </View>
              )}
            </View>
          ))}
        </View>

        {/* Pending Approvals */}
        {approvalState === 'pending' && (
          <View style={styles.approvalCard}>
            <View style={styles.approvalHeader}>
              <View style={styles.approvalDot} />
              <Text style={styles.approvalHeaderText}>Pending Approvals (1)</Text>
            </View>
            <View style={styles.approvalBody}>
              <Text style={styles.approvalTitle}>James Whitfield — Exec Protection · Tue 14:00</Text>
            </View>
            <View style={styles.approvalActions}>
              <TouchableOpacity style={styles.approveBtn} onPress={() => setApprovalState('approved')} activeOpacity={0.8}>
                <Icon name="check-circle" size={14} color="#86EFAC" />
                <Text style={styles.approveBtnText}>APPROVE</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.rejectBtn} onPress={() => setApprovalState('rejected')} activeOpacity={0.8}>
                <Icon name="close-circle" size={14} color="#FCA5A5" />
                <Text style={styles.rejectBtnText}>REJECT</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {approvalState === 'approved' && (
          <View style={[styles.approvalCard, {borderColor:'rgba(34,197,94,0.35)'}]}>
            <View style={styles.approvalConfirmRow}>
              <Icon name="check-circle" size={22} color="#4ade80" />
              <Text style={styles.approvalApprovedText}>Approved — James Whitfield · Exec Protection</Text>
            </View>
          </View>
        )}

        {approvalState === 'rejected' && (
          <View style={[styles.approvalCard, {borderColor:'rgba(239,68,68,0.3)'}]}>
            <View style={styles.approvalConfirmRow}>
              <Icon name="close-circle" size={22} color="#F87171" />
              <Text style={styles.approvalRejectedText}>Rejected — James Whitfield · Exec Protection</Text>
            </View>
          </View>
        )}

        {showInviteToast && (
          <View style={styles.inviteToast}>
            <Text style={styles.inviteToastText}>Invite sent. New member will appear once they accept.</Text>
          </View>
        )}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},

  header: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:16, paddingBottom:12},
  backBtn: {width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center'},
  headerTitle: {color:PRO_INDIGO, fontSize:12, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},

  content: {paddingHorizontal:16, paddingTop:4, gap:16},

  companyCard: {backgroundColor:'#0D1929', borderRadius:16, padding:16, borderWidth:1, borderColor:'rgba(99,102,241,0.25)'},
  companyRow: {flexDirection:'row', alignItems:'center', gap:12},
  companyIconWrap: {width:56, height:56, borderRadius:14, alignItems:'center', justifyContent:'center', backgroundColor:'#0D1929', borderWidth:1, borderColor:'rgba(99,102,241,0.3)'},
  companyInfo: {flex:1},
  companyName: {color:'#F1F5F9', fontSize:15, fontWeight:'800'},
  companyBadges: {flexDirection:'row', flexWrap:'wrap', gap:6, marginTop:6},

  badge: {paddingHorizontal:8, paddingVertical:2, borderRadius:99, borderWidth:1},
  badgeText: {fontSize:9, fontWeight:'800'},

  membersCard: {backgroundColor:'#0D1929', borderRadius:16, borderWidth:1, borderColor:'#1E2D45', overflow:'hidden'},
  memberCardHeader: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:16, paddingTop:16, paddingBottom:12},
  memberCardLabel: {color:'#475569', fontSize:10, fontWeight:'700', letterSpacing:2, textTransform:'uppercase'},
  memberCardCount: {color:'#334155'},
  addBtn: {width:28, height:28, borderRadius:14, alignItems:'center', justifyContent:'center', backgroundColor:'rgba(99,102,241,0.15)', borderWidth:1, borderColor:'rgba(99,102,241,0.3)'},
  memberRow: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:12, borderTopWidth:1, borderTopColor:'#1E2D45'},
  memberAvatar: {width:36, height:36, borderRadius:10, alignItems:'center', justifyContent:'center'},
  memberAvatarText: {fontSize:13, fontWeight:'700'},
  memberInfo: {flex:1},
  memberName: {color:'#E2E8F0', fontSize:13, fontWeight:'700'},
  memberRole: {color:'#475569', fontSize:11, marginTop:1},
  emptyMembers: {color:'#64748B', fontSize:12.5, paddingVertical:12, textAlign:'center'},

  approvalCard: {backgroundColor:'#0D1929', borderRadius:16, borderWidth:1, borderColor:'rgba(99,102,241,0.2)', overflow:'hidden'},
  approvalHeader: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:16, paddingTop:12, paddingBottom:8, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  approvalDot: {width:6, height:6, borderRadius:3, backgroundColor:'#F59E0B'},
  approvalHeaderText: {color:'#F59E0B', fontSize:10, fontWeight:'700', letterSpacing:1.2, textTransform:'uppercase'},
  approvalBody: {paddingHorizontal:16, paddingVertical:12},
  approvalTitle: {color:'#E2E8F0', fontSize:11, fontWeight:'800', letterSpacing:1, textTransform:'uppercase'},
  approvalActions: {flexDirection:'row', gap:8, paddingHorizontal:16, paddingBottom:16},
  approveBtn: {flex:1, paddingVertical:10, borderRadius:12, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, backgroundColor:'rgba(34,197,94,0.12)', borderWidth:1, borderColor:'rgba(34,197,94,0.25)'},
  approveBtnText: {color:'#86EFAC', fontSize:12, fontWeight:'700'},
  rejectBtn: {flex:1, paddingVertical:10, borderRadius:12, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, backgroundColor:'rgba(239,68,68,0.1)', borderWidth:1, borderColor:'rgba(239,68,68,0.2)'},
  rejectBtnText: {color:'#FCA5A5', fontSize:12, fontWeight:'700'},
  approvalConfirmRow: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:16},
  approvalApprovedText: {color:'#4ade80', fontSize:13, fontWeight:'700'},
  approvalRejectedText: {color:'#F87171', fontSize:13, fontWeight:'700'},

  inviteToast: {borderRadius:12, paddingHorizontal:16, paddingVertical:12, backgroundColor:'rgba(99,102,241,0.08)', borderWidth:1, borderColor:'rgba(99,102,241,0.2)'},
  inviteToastText: {color:'#A5B4FC', fontSize:12},
}));
