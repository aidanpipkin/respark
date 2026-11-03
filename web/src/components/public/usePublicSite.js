import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { call } from '@/components/workspace/api';
export default function usePublicSite(){const {search}=useLocation();const agent=new URLSearchParams(search).get('agent')||'';return useQuery({queryKey:['public-site',window.location.hostname,agent],queryFn:()=>call('getPublicSite',{host:window.location.hostname,agent}),staleTime:180000,refetchInterval:180000,retry:1});}