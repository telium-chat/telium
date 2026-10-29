import { useId } from 'react';
import {
  Activity, ArrowDownUp, ArrowLeftRight, ArrowLeft, AtSign, Ban, Bell, BellOff, Blocks, Bold, ChartColumn, Check, ChevronDown, ChevronRight,
  Circle, CircleMinus, Clock, Code, Copy, Cog, Ellipsis, Eye, EyeOff, Flag, Folder, FolderOpen, Gavel, Globe, Hash, Headphones,
  HeadphoneOff, House, Image, Inbox, Info, Italic, Key, LayoutGrid, LifeBuoy, Link2, ListOrdered, LoaderCircle, RotateCcw,
  HardDrive, Lock, LogOut, Megaphone, MessageSquare, MessageSquareText, Mic, MicOff, Monitor,
  MonitorOff, Moon, Paperclip, PenLine, Phone, PhoneOff, Pin, Plus, Quote, Reply, Rows3, Search,
  Scissors, Send, Server, Settings, Shield, ShieldAlert, Signal, SlidersHorizontal, Smile, Square, SquarePlus, Star,
  Strikethrough, Sun, Tag, Trash2,
  TriangleAlert, UserMinus, UserPlus, UserRound, Users, Video, VideoOff, SwitchCamera,
  Maximize2, Minimize2, Pause, Play, Volume2, VolumeX, X, Forward,
  Gamepad2, Music, Radio, Trophy, Tv,
  Sparkles,
} from 'lucide-react';

const icon = (Glyph) => {
  const Wrapped = ({ className = 'size-[18px]', strokeWidth = 1.75, ...rest }) => (
    <Glyph aria-hidden className={className} strokeWidth={strokeWidth} {...rest} />
  );
  Wrapped.displayName = `Icon(${Glyph.displayName || 'glyph'})`;
  return Wrapped;
};

export const HashIcon = icon(Hash);
export const VoiceIcon = icon(Volume2);
export const ForumIcon = icon(MessageSquareText);
export const TagIcon = icon(Tag);
export const SortIcon = icon(ArrowDownUp);
export const GalleryIcon = icon(LayoutGrid);
export const RowsIcon = icon(Rows3);
export const AnnouncementIcon = icon(Megaphone);
export const ThreadIcon = icon(MessageSquare);
export const CategoryIcon = icon(Folder);
export const FolderIcon = icon(Folder);
export const FolderOpenIcon = icon(FolderOpen);
export const ServerIcon = icon(Server);
export const GlobeIcon = icon(Globe);
export const HomeIcon = icon(House);

export const PlusIcon = icon(Plus);
export const CloseIcon = icon(X);
export const CheckIcon = icon(Check);
export const MoreIcon = icon(Ellipsis);
export const SendIcon = icon(Send);
export const ReplyIcon = icon(Reply);
export const BoldIcon = icon(Bold);
export const ItalicIcon = icon(Italic);
export const StrikeIcon = icon(Strikethrough);
export const CodeIcon = icon(Code);
export const QuoteIcon = icon(Quote);
export const SpoilerIcon = icon(EyeOff);
export const VisibilityIcon = icon(Eye);
export const VisibilityOffIcon = icon(EyeOff);
export const ForwardIcon = icon(Forward);
export const EditIcon = icon(PenLine);
export const TrashIcon = icon(Trash2);
export const RetryIcon = icon(RotateCcw);
export const CopyIcon = icon(Copy);
export const CutIcon = icon(Scissors);
export const FlagIcon = icon(Flag);
export const PinIcon = icon(Pin);
export const SearchIcon = icon(Search);
export const LinkIcon = icon(Link2);
export const AttachIcon = icon(Paperclip);
export const EmojiIcon = icon(Smile);
export const ImageIcon = icon(Image);
export const StarIcon = icon(Star);
export const AddChannelIcon = icon(SquarePlus);
export const MentionIcon = icon(AtSign);

export const ChevronDownIcon = icon(ChevronDown);
export const ChevronRightIcon = icon(ChevronRight);
export const BackIcon = icon(ArrowLeft);
export const SettingsIcon = icon(Settings);
export const HelpIcon = icon(LifeBuoy);
export const SparklesIcon = icon(Sparkles);
export const CogIcon = icon(Cog);
export const InboxIcon = icon(Inbox);
export const ListIcon = icon(ListOrdered);
export const SignOutIcon = icon(LogOut);
export const SwitchAccountIcon = icon(ArrowLeftRight);
export const SpinnerIcon = icon(LoaderCircle);
export const PlayIcon = icon(Play);
export const PauseIcon = icon(Pause);
export const StopIcon = icon(Square);
export const VolumeMuteIcon = icon(VolumeX);
export const FullscreenIcon = icon(Maximize2);
export const ExitFullscreenIcon = icon(Minimize2);

export const MembersIcon = icon(Users);
export const UserIcon = icon(UserRound);
export const AddFriendIcon = icon(UserPlus);
export const RemoveFriendIcon = icon(UserMinus);

const friendGlyph = (mark, label) => {
  const Glyph = ({ className = 'size-[18px]', ...rest }) => {
    const cut = `friend-cut-${useId().replace(/:/g, '')}`;
    return (
      <svg viewBox="0 0 24 24" aria-hidden className={className} {...rest}>
        <mask id={cut}>
          <rect width="24" height="24" fill="#fff" />
          <circle cx="18.5" cy="18" r="6" fill="#000" />
        </mask>
        <g mask={`url(#${cut})`} fill="currentColor">
          <circle cx="9.5" cy="7" r="4.25" />
          <path d="M1.5 20.25C1.5 15.9 5.1 13 9.5 13s8 2.9 8 7.25c0 .97-.78 1.75-1.75 1.75H3.25c-.97 0-1.75-.78-1.75-1.75Z" />
        </g>
        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {mark}
        </g>
      </svg>
    );
  };
  Glyph.displayName = `Icon(${label})`;
  return Glyph;
};
export const FriendsFilledIcon = friendGlyph(<path d="M15.25 18.25l2.1 2.1 3.9-4.35" />, 'friends');
export const AddFriendFilledIcon = friendGlyph(<path d="M18.5 14.75v6.5M15.25 18h6.5" />, 'add-friend');
export const FriendPendingFilledIcon = friendGlyph(
  <><circle cx="18.5" cy="18" r="3.75" /><path d="M18.5 16.25V18l1.1.9" strokeWidth="1.5" /></>,
  'friend-pending',
);
export const MessageIcon = icon(MessageSquare);

export const MicIcon = icon(Mic);
export const MicOffIcon = icon(MicOff);
export const HeadphonesIcon = icon(Headphones);
export const HeadphoneOffIcon = icon(HeadphoneOff);
export const DeafenIcon = icon(HeadphoneOff);
export const VideoIcon = icon(Video);
export const VideoOffIcon = icon(VideoOff);
export const SwitchCameraIcon = icon(SwitchCamera);
export const ScreenIcon = icon(Monitor);
export const ScreenOffIcon = icon(MonitorOff);
export const SignalIcon = icon(Signal);

export const PulseIcon = icon(Activity);
export const ChartIcon = icon(ChartColumn);
export const DiskIcon = icon(HardDrive);
export const PhoneIcon = icon(Phone);
export const PhoneOffIcon = icon(PhoneOff);

export const LockIcon = icon(Lock);
export const BellIcon = icon(Bell);
export const BellOffIcon = icon(BellOff);
export const ShieldIcon = icon(Shield);
export const ShieldAlertIcon = icon(ShieldAlert);
export const BanIcon = icon(Ban);
export const KickIcon = icon(Gavel);
export const WarnIcon = icon(TriangleAlert);
export const InfoIcon = icon(Info);
export const ClockIcon = icon(Clock);
export const KeyIcon = icon(Key);
export const AppsIcon = icon(Blocks);

export const ListeningIcon = icon(Music);
export const PlayingIcon = icon(Gamepad2);
export const StreamingIcon = icon(Radio);
export const WatchingIcon = icon(Tv);
export const CompetingIcon = icon(Trophy);

export const ACTIVITY_ICONS = {
  voice: VoiceIcon,
  listening: ListeningIcon,
  playing: PlayingIcon,
  streaming: StreamingIcon,
  watching: WatchingIcon,
  competing: CompetingIcon,
};

export const SunIcon = icon(Sun);
export const MoonIcon = icon(Moon);

const presenceIcon = (Glyph, token, fill = false) => {
  const Wrapped = ({ className = 'size-[18px]', strokeWidth = 1.75, style, ...rest }) => (
    <Glyph
      aria-hidden
      className={fill ? `${className} fill-current` : className}
      strokeWidth={strokeWidth}
      style={{ color: `var(${token})`, ...style }}
      {...rest}
    />
  );
  Wrapped.displayName = `Icon(${Glyph.displayName || 'glyph'})`;
  return Wrapped;
};

export const OnlineIcon = presenceIcon(Circle, '--success', true);
export const IdleIcon = presenceIcon(Moon, '--warning');
export const DndIcon = presenceIcon(CircleMinus, '--danger');
export const OfflineIcon = presenceIcon(Circle, '--muted');
export const AdvancedIcon = icon(SlidersHorizontal);

export function TeliumMark({ className = 'size-6', gradient = true, ...props }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      role="img"
      aria-label="Telium"
      className={className}
      {...props}
    >
      {gradient ? (
        <defs>
          <linearGradient id="teliumBrandGradient" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#C9AEFF" />
            <stop offset="36%" stopColor="#8B5FE8" />
            <stop offset="72%" stopColor="#6740C7" />
            <stop offset="100%" stopColor="#3F218D" />
          </linearGradient>
        </defs>
      ) : null}
      <g transform="translate(-3 0)">
        <path
          d="M 83.099 209.671 A 179 179 0 0 1 302.329 83.099"
          stroke={gradient ? 'url(#teliumBrandGradient)' : 'currentColor'}
          strokeWidth="48"
          strokeLinecap="round"
        />
        <path
          d="M 382.572 129.428 A 179 179 0 0 1 424.205 317.222"
          stroke={gradient ? 'url(#teliumBrandGradient)' : 'currentColor'}
          strokeWidth="48"
          strokeLinecap="round"
        />
        <path
          d="M 389.023 375.774 A 179 179 0 0 1 85.761 311.314"
          stroke={gradient ? 'url(#teliumBrandGradient)' : 'currentColor'}
          strokeWidth="48"
          strokeLinecap="round"
        />
        <path
          d="M 144.494 224.026 A 116 116 0 0 1 264.092 140.283"
          stroke={gradient ? 'url(#teliumBrandGradient)' : 'currentColor'}
          strokeWidth="24"
          strokeLinecap="round"
        />
        <path
          d="M 351.022 322.535 A 116 116 0 0 1 268.125 371.365"
          stroke={gradient ? 'url(#teliumBrandGradient)' : 'currentColor'}
          strokeWidth="24"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
